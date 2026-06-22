// Execute one generated History against real Obsidian nodes, then judge it.
//
// Default is the most BENIGN scenario for Sync: before any edit on a note from a
// *different* node than last touched it, wait until that note is synced
// everywhere — so cross-node edits are never concurrent and Sync has nothing to
// conflict. Aggressive behaviour (concurrent cross-node edits) is opt-in via
// opts.concurrent. "A sync happened" is detected by the cumulative
// `sync:history total` counter moving and settling (a level signal 1 s polling
// can't alias), confirmed by cross-node content identity. The token-survival
// oracle judges loss/duplication/convergence.

import { formatToken, type NodeId } from "./types.js";
import type { ObsidianDriver } from "./driver.js";
import type { Isolator } from "./isolate.js";
import type { RunLogger } from "./history.js";
import { sleep, gatherObservation } from "./runner.js";
import {
  checkRun,
  sameConflictSet,
  type AckedEdit,
  type NodeObservation,
  type RunVerdict,
} from "./oracle.js";
import type { History } from "./generator.js";

export interface ExecuteOpts {
  pollSec?: number; // sync-wait poll cadence (default 1)
  settlePolls?: number; // consecutive stable polls required (default 2)
  capSec?: number; // soft cap on a sync wait (default 60)
  concurrent?: boolean; // aggressive: allow concurrent cross-node edits (skip wait-for-synced)
}

export interface RunResult {
  verdict: RunVerdict;
  acked: AckedEdit[];
  observations: NodeObservation[];
  timings: { totalSec: number; convergenceSec: number; syncTimedOut: boolean };
}

/** Every node agrees (canonical + conflict set) on every note → converged. */
function notesConverged(notes: string[], obs: NodeObservation[]): boolean {
  for (const note of notes) {
    const o = obs.filter((x) => x.note === note);
    const first = o[0];
    if (!first) continue;
    for (const x of o.slice(1)) {
      if ((x.canonical ?? null) !== (first.canonical ?? null)) return false;
      if (!sameConflictSet(x.conflicts, first.conflicts)) return false;
    }
  }
  return true;
}

async function readTotals(drivers: ObsidianDriver[], notes: string[]): Promise<Record<string, number>> {
  const t: Record<string, number> = {};
  for (const note of notes) {
    const r = await drivers[0].syncVersionsTotal(note); // server-side, all nodes agree
    t[note] = r.ok ? (r.value ?? -1) : -1;
  }
  return t;
}

/**
 * Wait until the expected sync has happened and settled: the server-side version
 * counter is unchanged across the settle window AND all nodes agree on content.
 * Logs a per-note "synced" event with the counter's from→to (or "sync-timeout"
 * at the soft cap). `context` carries who/why (e.g. the node about to edit).
 */
async function waitForSynced(
  drivers: ObsidianDriver[],
  notes: string[],
  opts: ExecuteOpts,
  logger: RunLogger,
  context: Record<string, unknown> = {},
): Promise<{ seconds: number; timedOut: boolean }> {
  const pollMs = (opts.pollSec ?? 1) * 1000;
  const settle = opts.settlePolls ?? 2;
  const capMs = (opts.capSec ?? 60) * 1000;
  const start = Date.now();
  if (notes.length === 0) return { seconds: 0, timedOut: false };

  const baseline = await readTotals(drivers, notes);
  let prev = baseline;
  let stable = 0;
  for (;;) {
    const totals = await readTotals(drivers, notes);
    const obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));
    const totalsStable = notes.every((n) => totals[n] >= 0 && totals[n] === prev[n]);
    stable = totalsStable && notesConverged(notes, obs) ? stable + 1 : 0;

    const done = stable >= settle;
    const timedOut = !done && Date.now() - start > capMs;
    if (done || timedOut) {
      const seconds = Math.round((Date.now() - start) / 1000);
      for (const n of notes) {
        logger.log({ kind: timedOut ? "sync-timeout" : "synced", note: n, from: baseline[n], to: totals[n], seconds, ...context });
      }
      return { seconds, timedOut };
    }
    prev = totals;
    await sleep(pollMs);
  }
}

export async function runHistory(
  drivers: ObsidianDriver[],
  isolator: Isolator,
  logger: RunLogger,
  history: History,
  opts: ExecuteOpts = {},
): Promise<RunResult> {
  const byId = new Map(drivers.map((d) => [d.node, d]));
  const startedAt = Date.now();
  logger.artifact("history.json", history);

  // 0. nodes boot paused — start them all syncing.
  for (const d of drivers) {
    const r = await d.syncResume();
    logger.log({ kind: "resume", node: d.node, ok: r.ok });
  }

  // 1. apply ops in order. Acked only on CLI ok.
  const acked: AckedEdit[] = [];
  const notes = new Set<string>();
  const offline = new Set<NodeId>();
  const lastEditor = new Map<string, NodeId>();
  let seq = 0;
  const tokenFor = (node: NodeId) => formatToken({ node, seq: ++seq });

  for (const op of history) {
    if (op.delaySec) await sleep(op.delaySec * 1000);
    const d = byId.get(op.node);
    if (!d) {
      logger.log({ kind: "skip", node: op.node, reason: "unknown node" });
      continue;
    }
    if (op.kind === "create") {
      const token = tokenFor(op.node);
      const r = await d.createNote(op.note!, `base ${token}`);
      logger.log({ kind: "create", node: op.node, note: op.note, token, ok: r.ok, code: r.raw.code });
      if (r.ok) { acked.push({ note: op.note!, node: op.node, token }); notes.add(op.note!); lastEditor.set(op.note!, op.node); }
    } else if (op.kind === "edit") {
      // Benign default: before a cross-node edit, wait until the note is synced
      // everywhere so the editing node has the latest — no concurrency, nothing
      // for Sync to conflict. opts.concurrent skips this (aggressive).
      const prev = lastEditor.get(op.note!);
      if (!opts.concurrent && prev && prev !== op.node) {
        await waitForSynced(drivers, [op.note!], opts, logger, { before: op.node, note: op.note });
      }
      const token = tokenFor(op.node);
      const line = `edit ${token}`;
      const r = op.where === "prepend" ? await d.prependLine(op.note!, line) : await d.appendLine(op.note!, line);
      logger.log({ kind: "edit", node: op.node, note: op.note, where: op.where, token, ok: r.ok, code: r.raw.code });
      if (r.ok) { acked.push({ note: op.note!, node: op.node, token }); notes.add(op.note!); lastEditor.set(op.note!, op.node); }
    } else if (op.kind === "isolate") {
      await isolator.disconnect(op.node);
      offline.add(op.node);
      logger.log({ kind: "disconnect", node: op.node });
    } else if (op.kind === "heal") {
      await isolator.connect(op.node);
      offline.delete(op.node);
      logger.log({ kind: "reconnect", node: op.node });
    }
  }

  // 2. reconnect any still-offline node + ensure all syncing, then wait for the
  //    final sync to land and settle.
  for (const node of offline) {
    await isolator.connect(node);
    logger.log({ kind: "reconnect", node });
  }
  for (const d of drivers) await d.syncResume();
  const noteList = [...notes];
  const stab = await waitForSynced(drivers, noteList, opts, logger, { final: true });

  // 3. observe + judge.
  const observations = await Promise.all(drivers.flatMap((d) => noteList.map((n) => gatherObservation(d, n))));
  const verdict = checkRun(acked, observations);

  const timings = {
    totalSec: Math.round((Date.now() - startedAt) / 1000),
    convergenceSec: stab.seconds,
    syncTimedOut: stab.timedOut,
  };
  logger.log({ kind: "timings", ...timings });
  logger.results({ history, timings, acked, observations, verdict });
  return { verdict, acked, observations, timings };
}
