// Execute one DSL history against real Obsidian nodes, then judge it.
//
// A history is a sequence of user actions (see dsl.ts). The executor tracks the
// active node and active note as cursors and runs ops back-to-back; the only
// timing comes from explicit W (wait-for-sync) and P (pause) ops. Network D/C is
// the fault primitive (confirmed by ping in isolate.ts). At the end it always
// reconnects everyone, settles, and judges with the token-survival oracle. Loss =
// an acked edit absent from the vault after settling; sync:read is recorded only
// as a severity witness.

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
import { serialize, type History } from "./dsl.js";

export interface ExecuteOpts {
  noteName: (letter: string) => string; // DSL note letter -> concrete vault note name (per-rep)
  pollSec?: number; // observation poll cadence (default 1)
  minFloorSec?: number; // observe at least this long (catches slow-to-start syncs after C; default 3)
  capSec?: number; // soft cap on a wait (default 120)
  // "Synced" = the full observed state (every node's canonical + conflict-file set)
  // is converged AND unchanged for the settle window. The final settle uses a
  // longer window so a late conflict file (created client-side, then up/down-synced
  // ~2 round-trips after the note reconciles) is caught before judging.
  wSettleSec?: number; // mid-history W: quiescent-for window (default 4)
  finalSettleSec?: number; // final settle: quiescent-for window (default 25)
}

export interface LostForensic {
  note: string;
  token: string;
  serverRecoverable: boolean; // present in server history despite being gone from the vault
  serverVersions: number[];
}

export interface RunResult {
  verdict: RunVerdict;
  acked: AckedEdit[];
  observations: NodeObservation[];
  timings: { totalSec: number; convergenceSec: number; syncTimedOut: boolean };
  forensics: LostForensic[];
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

/** A signature of everything observable for `notes` across `drivers` — changes
 *  whenever any canonical content or any conflict file changes/appears. */
function signature(notes: string[], obs: NodeObservation[]): string {
  const parts: string[] = [];
  for (const note of notes) {
    for (const o of obs.filter((x) => x.note === note).sort((a, b) => a.node.localeCompare(b.node))) {
      const conflicts = o.conflicts.map((c) => `${c.file}=${c.content}`).sort().join("|");
      parts.push(`${note}@${o.node}:${o.canonical}#${conflicts}`);
    }
  }
  return parts.join("\n");
}

/**
 * Wait until the vault is genuinely quiescent for `notes` across `drivers`: the
 * full observed state (every node's canonical content AND conflict-file set) is
 * converged across nodes AND has been UNCHANGED for `settleSec`. A conflict file
 * that arrives late changes the state → resets the window, so we keep waiting
 * rather than judge mid-sync. `minFloorSec` guards the just-after-connect case
 * where a sync hasn't started yet. No blind dwell — this is the explicit wait.
 */
async function waitForSynced(
  drivers: ObsidianDriver[],
  notes: string[],
  settleSec: number,
  opts: ExecuteOpts,
  logger: RunLogger,
  context: Record<string, unknown> = {},
): Promise<{ seconds: number; timedOut: boolean }> {
  const pollMs = (opts.pollSec ?? 1) * 1000;
  const floorMs = (opts.minFloorSec ?? 3) * 1000;
  const settleMs = settleSec * 1000;
  const capMs = (opts.capSec ?? 120) * 1000;
  const start = Date.now();
  if (notes.length === 0 || drivers.length === 0) return { seconds: 0, timedOut: false };

  const baseline = await readTotals(drivers, notes);
  let lastSig: string | null = null;
  let lastChange = start;
  for (;;) {
    const obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));
    const sig = signature(notes, obs);
    const now = Date.now();
    if (sig !== lastSig) { lastSig = sig; lastChange = now; }

    const converged = notesConverged(notes, obs);
    const quietMs = now - lastChange;
    const elapsed = now - start;
    const done = converged && quietMs >= settleMs && elapsed >= floorMs;
    const timedOut = !done && elapsed > capMs;
    if (done || timedOut) {
      const totals = await readTotals(drivers, notes);
      const seconds = Math.round(elapsed / 1000);
      if (timedOut) {
        // Capture each node's own sync state — a wedged node (e.g. stuck "syncing"
        // after a network reconnect) is the usual cause and is worth seeing later.
        for (const d of drivers) {
          const st = await d.syncStatus();
          const state = st.ok ? (/^status:\s*(\S+)/m.exec(st.value ?? "")?.[1] ?? "?") : "error";
          logger.log({ kind: "status-at-timeout", node: d.node, state });
        }
      }
      for (const n of notes) {
        logger.log({ kind: timedOut ? "sync-timeout" : "synced", note: n, from: baseline[n], to: totals[n], seconds, ...context });
      }
      return { seconds, timedOut };
    }
    await sleep(pollMs);
  }
}

/** Severity witness: which "lost" tokens are still recoverable from server history. */
async function lostForensics(driver: ObsidianDriver, verdict: RunVerdict): Promise<LostForensic[]> {
  const out: LostForensic[] = [];
  for (const nv of verdict.notes) {
    if (nv.lost.length === 0) continue;
    const totalR = await driver.syncVersionsTotal(nv.note);
    const total = totalR.ok ? (totalR.value ?? 0) : 0;
    const contents: string[] = [];
    for (let v = 0; v < total; v++) {
      const r = await driver.syncRead(nv.note, v);
      contents.push(r.ok ? (r.value ?? "") : "");
    }
    for (const token of nv.lost) {
      const versions = contents.map((c, i) => (c.includes(token) ? i : -1)).filter((i) => i >= 0);
      out.push({ note: nv.note, token, serverRecoverable: versions.length > 0, serverVersions: versions });
    }
  }
  return out;
}

export async function runHistory(
  drivers: ObsidianDriver[],
  isolator: Isolator,
  logger: RunLogger,
  history: History,
  opts: ExecuteOpts,
): Promise<RunResult> {
  const startedAt = Date.now();
  const str = serialize(history);
  logger.artifact("history.json", { string: str, ops: history });

  // Network is the only isolation layer, so sync stays on the whole run.
  for (const d of drivers) {
    const r = await d.syncResume();
    logger.log({ kind: "resume", node: d.node, ok: r.ok });
  }

  const driverOf = (num: number) => drivers[num - 1];
  const online = () => drivers.filter((_, idx) => !offline.has(idx + 1));

  let activeNode = 1;
  let activeNote: string | undefined;
  const offline = new Set<number>(); // node numbers currently network-disconnected
  const touched = new Set<string>(); // concrete note names seen this run
  const acked: AckedEdit[] = [];
  let seq = 0;

  for (const op of history) {
    switch (op.cmd) {
      case "node":
        activeNode = op.node!;
        break;
      case "select":
        activeNote = opts.noteName(op.note!);
        touched.add(activeNote);
        break;
      case "pause":
        logger.log({ kind: "pause", node: activeNode, seconds: op.seconds });
        await sleep((op.seconds ?? 10) * 1000);
        break;
      case "disconnect":
        await isolator.disconnect(driverOf(activeNode).node);
        offline.add(activeNode);
        logger.log({ kind: "disconnect", node: driverOf(activeNode).node });
        break;
      case "connect":
        await isolator.connect(driverOf(activeNode).node);
        offline.delete(activeNode);
        logger.log({ kind: "reconnect", node: driverOf(activeNode).node });
        break;
      case "wait": {
        if (!activeNote) break;
        if (offline.has(activeNode)) {
          logger.log({ kind: "wait-skip", node: driverOf(activeNode).node, note: activeNote, reason: "offline" });
          break;
        }
        await waitForSynced(online(), [activeNote], opts.wSettleSec ?? 4, opts, logger, { wait: driverOf(activeNode).node });
        break;
      }
      case "append": {
        if (!activeNote) break;
        const d = driverOf(activeNode);
        const token = formatToken({ node: d.node, seq: ++seq });
        // Create if THIS node doesn't have the note locally yet, else append. So
        // editing before propagation is a natural create-create; after, it's
        // append-contention — timing decides, no forced sync.
        const exists = await d.exists(activeNote);
        const r = exists
          ? await d.appendLine(activeNote, `edit ${token}`)
          : await d.createNote(activeNote, `base ${token}`);
        logger.log({ kind: exists ? "append" : "create", node: d.node, note: activeNote, token, ok: r.ok, code: r.raw.code });
        if (r.ok) acked.push({ note: activeNote, node: d.node, token });
        break;
      }
    }
  }

  // Final settle: reconnect everyone, ensure syncing, wait until all agree, then
  // dwell (conflict files lag) before observing.
  for (const num of offline) {
    await isolator.connect(driverOf(num).node);
    logger.log({ kind: "reconnect", node: driverOf(num).node });
  }
  offline.clear();
  for (const d of drivers) await d.syncResume();
  const noteList = [...touched];
  // Final settle: wait until the whole vault (canonical + conflict files) is
  // converged and quiescent for the long window — explicitly waiting out the
  // conflict file's own ~2-round-trip sync rather than dwelling blindly.
  const stab = await waitForSynced(drivers, noteList, opts.finalSettleSec ?? 25, opts, logger, { final: true });

  const observations = await Promise.all(drivers.flatMap((d) => noteList.map((n) => gatherObservation(d, n))));
  const verdict = checkRun(acked, observations);

  const forensics = await lostForensics(drivers[0], verdict);
  for (const f of forensics) {
    logger.log({ kind: "lost-forensic", note: f.note, token: f.token, serverRecoverable: f.serverRecoverable, serverVersions: f.serverVersions });
  }

  const timings = {
    totalSec: Math.round((Date.now() - startedAt) / 1000),
    convergenceSec: stab.seconds,
    syncTimedOut: stab.timedOut,
  };
  logger.log({ kind: "timings", ...timings });
  logger.results({ history: str, timings, acked, observations, verdict, forensics });
  return { verdict, acked, observations, timings, forensics };
}
