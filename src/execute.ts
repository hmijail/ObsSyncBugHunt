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
import { serialize, DEFAULT_PAUSE_SEC, type History } from "./dsl.js";

export interface ExecuteOpts {
  noteName: (letter: string) => string; // DSL note letter -> concrete vault note name (per-rep)
  pollSec?: number; // observation poll cadence (default 1)
  minFloorSec?: number; // observe at least this long (catches slow-to-start syncs after C; default 3)
  capSec?: number; // soft cap on a wait (default 120)
  // Done = every node reports `synced` AND the full observed state (canonical +
  // conflict-file set) is converged AND has held for the settle window. The `synced`
  // gate means the window only has to absorb a just-lagging conflict file, not stand
  // in for "Sync is idle", so it can be short. Set to 0 for a pure synced+converged
  // check (relies entirely on the conflict-set equality to catch a late conflict file).
  wSettleSec?: number; // mid-history W: quiescent-for window (default 4)
  finalSettleSec?: number; // final settle: quiescent-for window (default 6)
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
  timings: { totalSec: number; convergenceSec: number; syncTimedOut: boolean; unsynced: boolean };
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

/** A node's own sync state, e.g. "synced" / "syncing" (or "error"/"?" if unreadable). */
async function syncState(d: ObsidianDriver): Promise<string> {
  const st = await d.syncStatus();
  return st.ok ? (/^status:\s*(\S+)/m.exec(st.value ?? "")?.[1] ?? "?") : "error";
}

/**
 * Wait until the vault is genuinely quiescent for `notes` across `drivers`: every
 * node reports `synced` (Sync's own "idle" signal), the full observed state (each
 * node's canonical content AND conflict-file set) is converged across nodes, and
 * that has held for `settleSec`. The `synced` gate lets the window stay short while
 * still not judging mid-sync; a late conflict file is a content change that resets
 * the window. `minFloorSec` guards the just-after-connect case where a sync hasn't
 * started yet. No blind dwell — this is the explicit wait.
 */
async function waitForSynced(
  drivers: ObsidianDriver[],
  notes: string[],
  settleSec: number,
  opts: ExecuteOpts,
  logger: RunLogger,
  context: Record<string, unknown> = {},
): Promise<{ seconds: number; timedOut: boolean; unsynced: boolean }> {
  const pollMs = (opts.pollSec ?? 1) * 1000;
  const floorMs = (opts.minFloorSec ?? 3) * 1000;
  const settleMs = settleSec * 1000;
  const capMs = (opts.capSec ?? 120) * 1000;
  const start = Date.now();
  if (notes.length === 0 || drivers.length === 0) return { seconds: 0, timedOut: false, unsynced: false };

  const baseline = await readTotals(drivers, notes);
  let lastSig: string | null = null;
  let lastChange = start;
  for (;;) {
    const obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));
    const sig = signature(notes, obs);
    const now = Date.now();
    if (sig !== lastSig) { lastSig = sig; lastChange = now; }

    const converged = notesConverged(notes, obs);
    // Only consult Sync's own signal once content agrees, to avoid polling status
    // during active propagation: finish when every node reports `synced` AND the
    // converged state has held for the (now short) window.
    const allSynced = converged && (await Promise.all(drivers.map(syncState))).every((s) => s === "synced");
    const quietMs = now - lastChange;
    const elapsed = now - start;
    const done = converged && allSynced && quietMs >= settleMs && elapsed >= floorMs;
    const timedOut = !done && elapsed > capMs;
    if (done || timedOut) {
      const totals = await readTotals(drivers, notes);
      const seconds = Math.round(elapsed / 1000);
      // A note with no server-side history (total < 1) never reached the server —
      // it is NOT synced however quiescent the local vault looks. Distinct from a
      // timeout (which is inconclusive); this is a hard "nothing got there".
      const unsynced = !timedOut && notes.some((n) => totals[n] < 1);
      if (timedOut) {
        // Capture each node's own sync state — a wedged node (e.g. stuck "syncing"
        // after a network reconnect) is the usual cause and is worth seeing later.
        for (const d of drivers) {
          logger.log({ kind: "status-at-timeout", node: d.node, state: await syncState(d) });
        }
      }
      // Snapshot each node's settled content for the audit trail — a time series
      // across the run's W's catches a token that vanished then recovered before the
      // final check (which only ever sees the end state).
      for (const o of obs) {
        logger.log({ kind: "content-at-wait", note: o.note, node: o.node, canonical: o.canonical, conflicts: o.conflicts, ...context });
      }
      for (const n of notes) {
        const kind = timedOut ? "sync-timeout" : totals[n] < 1 ? "unsynced" : "synced";
        logger.log({ kind, note: n, from: baseline[n], to: totals[n], seconds, ...context });
      }
      return { seconds, timedOut, unsynced };
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

/** Gate the start of a rep on a known-clean baseline: every node reporting `synced`. */
async function waitNodesSynced(drivers: ObsidianDriver[], capSec: number, logger: RunLogger): Promise<void> {
  const deadline = Date.now() + capSec * 1000;
  for (;;) {
    const states = await Promise.all(drivers.map(async (d) => {
      const st = await d.syncStatus();
      return st.ok ? (/^status:\s*(\S+)/m.exec(st.value ?? "")?.[1] ?? "?") : "error";
    }));
    if (states.every((s) => s === "synced")) { logger.log({ kind: "baseline-synced", states }); return; }
    if (Date.now() > deadline) { logger.log({ kind: "baseline-sync-timeout", states }); return; }
    await sleep(1000);
  }
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
  // Start from a known-clean baseline: don't begin editing until every node is synced.
  await waitNodesSynced(drivers, opts.capSec ?? 120, logger);

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
        await driverOf(activeNode).open(activeNote); // foreground in the GUI (no-op if not yet created)
        break;
      case "pause":
        logger.log({ kind: "pause", node: activeNode, seconds: op.seconds });
        await sleep((op.seconds ?? DEFAULT_PAUSE_SEC) * 1000);
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
        if (!activeNote) break; // nothing selected to wait on
        // A W on a disconnected node (or with no online peer to sync with) can't
        // make progress — NOP it rather than block. (waitForSynced is also hard-
        // bounded by capSec, so a W never hangs even in the online case.)
        if (offline.has(activeNode) || online().length === 0) {
          const reason = offline.has(activeNode) ? "offline" : "no-online-peers";
          logger.log({ kind: "wait-skip", node: driverOf(activeNode).node, note: activeNote, reason });
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
        // Foreground the note on the EDITING node before each edit — the active node
        // changes via `N` without re-selecting, so opening here (not just on select)
        // makes the GUI follow whichever node is actually writing.
        if (exists) { await d.open(activeNote); await d.appendLine(activeNote, `edit ${token}`); }
        else { await d.createNote(activeNote, `base ${token}`); await d.open(activeNote); }
        // Exit codes are meaningless (the CLI always exits 0) and append-to-missing
        // silently no-ops — so we only ack an edit after reading its token back
        // locally. A no-op then can't masquerade as an acknowledged-then-lost edit.
        const back = await d.read(activeNote);
        const landed = (back.value ?? "").includes(token);
        logger.log({ kind: exists ? "append" : "create", node: d.node, note: activeNote, token, landed });
        if (landed) acked.push({ note: activeNote, node: d.node, token });
        else logger.log({ kind: "edit-failed", node: d.node, note: activeNote, token });
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
  const stab = await waitForSynced(drivers, noteList, opts.finalSettleSec ?? 6, opts, logger, { final: true });

  const observations = await Promise.all(drivers.flatMap((d) => noteList.map((n) => gatherObservation(d, n))));
  const verdict = checkRun(acked, observations);

  // Surface conflict-file structure: device named in the file (the producing node),
  // whether the name is well-formed, and which nodes hold it. A malformed name is
  // worth eyeballing even though it doesn't gate the token oracle.
  for (const nv of verdict.notes) {
    for (const cm of nv.conflictMeta) {
      logger.log({ kind: "conflict-file", note: nv.note, file: cm.file, device: cm.device, wellFormed: cm.wellFormed, holders: cm.holders });
    }
  }

  const forensics = await lostForensics(drivers[0], verdict);
  for (const f of forensics) {
    logger.log({ kind: "lost-forensic", note: f.note, token: f.token, serverRecoverable: f.serverRecoverable, serverVersions: f.serverVersions });
  }

  const timings = {
    totalSec: Math.round((Date.now() - startedAt) / 1000),
    convergenceSec: stab.seconds,
    syncTimedOut: stab.timedOut,
    unsynced: stab.unsynced,
  };
  logger.log({ kind: "timings", ...timings });
  logger.results({ history: str, timings, acked, observations, verdict, forensics });
  return { verdict, acked, observations, timings, forensics };
}
