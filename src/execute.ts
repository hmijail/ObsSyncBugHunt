// Execute one generated History against real Obsidian nodes, then judge it.
//
// Causal model (NOT a sync-state mirror): apply the ops in order; after they're
// done, reconnect/resume everything and wait for the expected sync to actually
// happen — detected by the cumulative `sync:history total` counter moving and
// then settling (a level signal that 1 s polling can't alias), confirmed by
// cross-node content identity. A soft ~60 s cap stops us waiting forever. The
// token-survival oracle is the judge of loss/duplication/convergence.

import { randomUUID } from "node:crypto";
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
  pollSec?: number; // stabilization poll cadence (default 1)
  settlePolls?: number; // consecutive stable polls required (default 2)
  capSec?: number; // soft cap on the post-run sync wait (default 60)
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

/**
 * After the ops, wait until the expected sync has happened and settled: the
 * server-side version counter (`sync:history total`) is unchanged across a settle
 * window AND all nodes agree on content. Returns the seconds waited and whether
 * we hit the soft cap (a "worth a look", not a verdict).
 */
async function waitForStabilization(
  drivers: ObsidianDriver[],
  notes: string[],
  opts: ExecuteOpts,
): Promise<{ seconds: number; timedOut: boolean }> {
  const pollMs = (opts.pollSec ?? 1) * 1000;
  const settle = opts.settlePolls ?? 2;
  const capMs = (opts.capSec ?? 60) * 1000;
  const start = Date.now();
  if (notes.length === 0) return { seconds: 0, timedOut: false };

  let prevTotals: Record<string, number> | null = null;
  let stableCount = 0;
  for (;;) {
    const totals: Record<string, number> = {};
    for (const note of notes) {
      const r = await drivers[0].syncVersionsTotal(note);
      totals[note] = r.ok ? (r.value ?? -1) : -1;
    }
    const obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));

    const totalsStable =
      prevTotals !== null && notes.every((n) => totals[n] >= 0 && totals[n] === prevTotals![n]);
    stableCount = totalsStable && notesConverged(notes, obs) ? stableCount + 1 : 0;
    if (stableCount >= settle) return { seconds: Math.round((Date.now() - start) / 1000), timedOut: false };
    if (Date.now() - start > capMs) return { seconds: Math.round((Date.now() - start) / 1000), timedOut: true };
    prevTotals = totals;
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

  // 1. apply ops in order, pacing with delaySec. Acked only on CLI ok.
  const acked: AckedEdit[] = [];
  const notes = new Set<string>();
  const offline = new Set<NodeId>();
  let seq = 0;
  const tokenFor = (node: NodeId) => formatToken({ node, seq: ++seq, uuid: randomUUID().slice(0, 8) });

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
      if (r.ok) { acked.push({ note: op.note!, node: op.node, token }); notes.add(op.note!); }
    } else if (op.kind === "edit") {
      const token = tokenFor(op.node);
      const line = `edit ${token}`;
      const r = op.where === "prepend" ? await d.prependLine(op.note!, line) : await d.appendLine(op.note!, line);
      logger.log({ kind: "edit", node: op.node, note: op.note, where: op.where, token, ok: r.ok, code: r.raw.code });
      if (r.ok) { acked.push({ note: op.note!, node: op.node, token }); notes.add(op.note!); }
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
  //    expected sync to land and settle.
  for (const node of offline) {
    await isolator.connect(node);
    logger.log({ kind: "reconnect", node });
  }
  for (const d of drivers) await d.syncResume();
  const noteList = [...notes];
  const stab = await waitForStabilization(drivers, noteList, opts);
  logger.log({ kind: stab.timedOut ? "sync-timeout" : "stabilized", seconds: stab.seconds });

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
