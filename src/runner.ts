// Orchestrator for one "divergence round":
//
//   1. create the note on one node and wait until it propagates to all
//      (so every node edits from a common base)
//   2. isolate one node from the cloud
//   3. every node appends a uniquely-tagged line to the same note
//   4. heal the isolated node
//   5. wait for quiescence (canonical content stable and equal across nodes)
//   6. gather observations and run the oracle
//
// Requires real Obsidian nodes; wired to Podman in the topology step. The
// oracle it calls is already unit-tested (src/oracle.test.ts).

import assert from "node:assert/strict";
import { formatToken, type NodeId } from "./types.js";
import { ObsidianDriver, isConflictFile } from "./driver.js";
import { AlarmError } from "./alarm.js";
import type { Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import {
  checkRun,
  type AckedEdit,
  type ConflictFile,
  type NodeObservation,
  type RunVerdict,
} from "./oracle.js";

export interface DivergenceOpts {
  note: string;
  isolatedNode: NodeId;
  baseContent?: string;
  basePropagationMs?: number; // max wait for the base note to reach all nodes
  quiescenceMs?: number; // max wait for convergence after heal
  pollMs?: number;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readCanonical(d: ObsidianDriver, note: string): Promise<string | null> {
  const r = await d.read(note);
  // read() positively distinguishes present (ok) from absent; normalize absent to null so
  // it can't masquerade as canonical content.
  return r.ok ? (r.value ?? null) : null;
}

/** Wait until every node's canonical content contains `marker`, or timeout. */
async function waitForPropagation(
  drivers: ObsidianDriver[],
  note: string,
  marker: string,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reads = await Promise.all(drivers.map((d) => readCanonical(d, note)));
    if (reads.every((c) => c !== null && c.includes(marker))) return true;
    if (Date.now() > deadline) return false;
    await sleep(pollMs);
  }
}

export interface QuiescenceResult {
  quiesced: boolean;
  reason: "synced" | "timeout";
}

/**
 * Quiescence is decided solely by Obsidian's own `sync:status`: every node must
 * report `synced`, stable across two polls. There is no content-stability
 * fallback — it could mask a node that simply hasn't started pulling yet. If
 * `sync:status` is unreadable on any node (errored or unparseable) we throw:
 * that's an abnormal condition worth surfacing, not papering over. A timeout
 * returns `{quiesced:false}` so the caller can record a node stuck `syncing`.
 */
async function waitForQuiescence(
  drivers: ObsidianDriver[],
  timeoutMs: number,
  pollMs: number,
): Promise<QuiescenceResult> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveSynced = 0;
  for (;;) {
    const probes = await Promise.all(
      drivers.map(async (d) => {
        // syncStatus() returns the validated status word (or has already aborted on an
        // unrecognized one), so res.value is authoritative.
        const res = await d.syncStatus();
        return { node: d.node, state: res.value ?? null };
      }),
    );

    // syncStatus()'s own contract guarantees a value or a throw (see the comment above) — this
    // is checking OUR OWN code held that contract, not a new black-box inconsistency, so assert
    // is the right tool (unlike gatherObservation's AlarmError below, which IS a real finding).
    for (const p of probes) assert(p.state !== null, `syncStatus on ${p.node} returned no status`);

    consecutiveSynced = probes.every((p) => p.state === "synced") ? consecutiveSynced + 1 : 0;
    if (consecutiveSynced >= 2) return { quiesced: true, reason: "synced" };
    if (Date.now() > deadline) return { quiesced: false, reason: "timeout" };
    await sleep(pollMs);
  }
}

export async function gatherObservation(d: ObsidianDriver, note: string): Promise<NodeObservation> {
  const canonical = await readCanonical(d, note);
  const files = (await d.listFiles()).value ?? [];
  // Anchor (positive identification of the listing): if the note reads as PRESENT, the
  // folder listing MUST contain it. A listing that omits a note we just read is self-
  // inconsistent and can fabricate a false "loss" (see docs/cli-trust.md's founding incident) —
  // don't trust such a listing; raise a loud ALARM instead.
  if (canonical !== null && !files.includes(`${note}.md`)) {
    throw new AlarmError("cli-listing-inconsistent", {
      node: d.node, note, listedCount: files.length,
      detail: "note read as present but absent from `files` listing — listing untrustworthy",
    });
  }
  const conflicts: ConflictFile[] = [];
  for (const f of files) {
    if (isConflictFile(f) && f.startsWith(`${note} (Conflicted copy`)) {
      const c = await d.readByPath(f);
      conflicts.push({ file: f, content: c.ok ? (c.value ?? "") : "" });
    }
  }
  return { node: d.node, note, canonical, conflicts };
}

export async function runDivergenceRound(
  drivers: ObsidianDriver[],
  isolator: Isolator,
  logger: RunLogger,
  opts: DivergenceOpts,
): Promise<RunVerdict> {
  const { note, isolatedNode } = opts;
  const baseContent = opts.baseContent ?? "base line";
  const basePropagationMs = opts.basePropagationMs ?? 60_000;
  const quiescenceMs = opts.quiescenceMs ?? 60_000;
  const pollMs = opts.pollMs ?? 3_000;
  const startedAt = Date.now();

  // 0. ensure every node is actively syncing. Obsidian boots a fresh device/
  // session with Sync PAUSED (confirmed empirically), so an unresumed node would
  // silently never exchange edits — making the contention fake and any "no data
  // loss" verdict meaningless. Resume all, then wait for a synced baseline so the
  // base note propagates from a known-converged state.
  for (const d of drivers) {
    const r = await d.syncResume();
    logger.log({ kind: "resume", node: d.node, ok: r.ok });
  }
  const baseline = await waitForQuiescence(drivers, basePropagationMs, pollMs);
  logger.log({ kind: "baseline", ...baseline });
  if (!baseline.quiesced) {
    console.warn(
      `[runner] nodes did not reach "synced" baseline within ${basePropagationMs}ms ` +
        `after resume — proceeding, but the run starts from a non-converged state`,
    );
  }

  // 1. common base
  const base = drivers[0];
  logger.log({ kind: "create", node: base.node, note });
  await base.createNote(note, baseContent);
  const propagated = await waitForPropagation(drivers, note, baseContent, basePropagationMs, pollMs);
  const propagatedAt = Date.now();
  logger.log({ kind: "base-propagated", note, propagated });

  // 2. offline window
  logger.log({ kind: "isolate", node: isolatedNode });
  await isolator.disconnect(isolatedNode);

  // 3. divergent appends (the isolated node edits offline; others sync)
  const acked: AckedEdit[] = [];
  let seq = 0;
  for (const d of drivers) {
    seq += 1;
    const token = formatToken({ node: d.node, seq, note });
    const r = await d.appendLine(note, `edit ${token}`);
    logger.log({ kind: "append", node: d.node, note, token, ok: r.ok, code: r.raw.code });
    if (r.ok) acked.push({ note, node: d.node, token });
  }

  // 4. heal
  logger.log({ kind: "heal", node: isolatedNode });
  await isolator.connect(isolatedNode);
  const healedAt = Date.now();

  // 5. quiescence — trust sync:status exclusively
  let quiescence: QuiescenceResult;
  try {
    quiescence = await waitForQuiescence(drivers, quiescenceMs, pollMs);
  } catch (e) {
    logger.log({ kind: "quiescence-error", note, error: String(e) });
    throw e;
  }
  const quiescedAt = Date.now();
  logger.log({ kind: "quiescence", note, ...quiescence });
  if (!quiescence.quiesced) {
    // Not silently ignored: a node never reached `synced` (e.g. stuck syncing /
    // conflict loop) — itself a notable finding. We still observe its state.
    console.warn(
      `[runner] nodes did not all reach "synced" within ${quiescenceMs}ms — ` +
        `recording the current (non-quiescent) state; weigh the verdict accordingly`,
    );
  }

  // 6. observe + judge
  const observations = await Promise.all(drivers.map((d) => gatherObservation(d, note)));
  const verdict = checkRun(acked, observations);

  // 7. timings — durations can themselves be a signal (e.g. slow convergence
  // alongside data loss). All in milliseconds.
  const timings = {
    totalMs: Date.now() - startedAt,
    propagationMs: propagatedAt - startedAt, // create -> base visible on all nodes
    convergenceMs: quiescedAt - healedAt, // heal -> all nodes report synced
  };
  logger.log({ kind: "timings", note, ...timings });

  logger.results({ opts, propagated, quiescence, timings, acked, observations, verdict });
  return verdict;
}
