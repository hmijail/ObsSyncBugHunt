// Execute one DSL history against real Obsidian nodes, then judge it.
//
// A history is a sequence of user actions (see dsl.ts). The executor tracks the
// active node and active note as cursors and runs ops back-to-back; the only
// timing comes from explicit W (wait-for-sync) and P (pause) ops. Network D/C is
// the fault primitive (confirmed by ping in isolate.ts). At the end it always
// reconnects everyone, settles, and judges with the token-survival oracle. Loss =
// an acked edit absent from the vault after settling; sync:read is recorded only
// as a severity witness.

import assert from "node:assert/strict";
import { formatToken, NOTE_DIR, type NodeId } from "./types.js";
import { isConflictFile, type ObsidianDriver } from "./driver.js";
import { AlarmError } from "./alarm.js";
import type { Isolator } from "./isolate.js";
import type { RunLogger } from "./history.js";
import { sleep, gatherObservation } from "./runner.js";
import { hostOnline } from "./net.js";
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
  // Settled = every node reports `synced` AND the observed state has been unchanged
  // for this window. Convergence is judged separately by the oracle, so a stable but
  // divergent state finishes here (as `-SYNCBAD`) instead of waiting out the cap. The
  // window absorbs a just-lagging conflict file; keep it short since `synced` already
  // means "Sync is idle".
  wSettleSec?: number; // mid-history W: quiescent-for window (default 4)
  finalSettleSec?: number; // final settle: quiescent-for window (default 15)
  // Per-call cap on the settle's `sync:status` probe (default 5). `sync:status` blocks until
  // synced, so this bounds it into a pollable "synced yet?" — a timeout means "still syncing".
  // Must stay comfortably above a synced node's instant reply, well below the settle window.
  probeSec?: number;
  // When the settle cap elapses, tell a Sync failure apart from a host-internet
  // outage: if the host itself is offline, wait for connectivity to return and restart
  // the window instead of recording a false timeout. Disabled by --skip-host-check —
  // a sandbox with no outbound TCP would otherwise treat the cap as a permanent outage
  // and wait forever. Default on.
  hostCheck?: boolean;
  // Per-call `ms` timing on the pause-snapshot (debug/observability aid — see the "pause"
  // case, useful for spotting a slow snapshot call). Default ON; --skip-snapshot-timing turns
  // it off without touching the snapshot logic itself.
  snapshotTiming?: boolean;
  // Recorded into the `history` event only — neither changes execution here. A rep's
  // outcome can depend on which of these governed it (confirmed: the isolator choice alone
  // flips whether a concurrent-create collision produces a conflict file), so both need to
  // travel WITH the rep's own trace, not just live in the invocation's separate run log.
  isolator?: string; // "network" | "sync" — which fault primitive drove this run's D/C
  obsidianVersion?: string; // the CLI's own self-reported version, queried once at startup
  // The Mac (DSL `M`), when configured: its 1-based position within `drivers` (it's just
  // another element of that array, always last — see run.ts) and its own self-reported
  // Obsidian version (likely different from the containers' pinned build, which is the
  // whole point of testing against it). `macNode` drives both `case "mac"`'s resolution
  // and the D/C defense-in-depth assert below — undefined means no Mac is configured.
  macNode?: number;
  macObsidianVersion?: string;
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

/** A node's own sync state via the BOUNDED probe, e.g. "synced" / "syncing" / "timeout" (killed
 *  before a reply came back — not positively confirmed as any specific state) / "?" (unreadable).
 *  Bounded so the settle loop polls instead of blocking ~70s on `sync:status` (which would
 *  straddle the quiescence window and fabricate a `-SYNCBAD` — see waitForSynced). */
async function syncState(d: ObsidianDriver, probeMs: number): Promise<string> {
  return d.syncStateProbe(probeMs);
}

/** The Mac has no network-level isolation (see dsl.ts's assertMacAlwaysConnected) — its Sync
 *  being on is the whole load-bearing assumption of testing against it. Checked before every op
 *  that actually touches it (append/wait), using the same bounded, non-blocking probe the settle
 *  uses. Only a POSITIVELY-read off-state aborts; a probe "timeout"/"?" (inconclusive, e.g.
 *  mid-sync) is tolerated — never manufacture a failure from an inconclusive bounded probe (same
 *  philosophy as syncStateProbe itself). Throws a plain Error (not AlarmError): a Mac with Sync
 *  off invalidates every subsequent rep until a human fixes it, so this must escape runRep's
 *  per-rep catch and abort the whole soak, not just tag one rep -OBSFAIL. */
const MAC_SYNC_OFF_STATES = new Set(["paused", "error", "stopped", "offline"]);
async function assertMacSyncOn(driver: ObsidianDriver, opts: ExecuteOpts): Promise<void> {
  const probeMs = (opts.probeSec ?? 5) * 1000;
  const state = await syncState(driver, probeMs);
  if (MAC_SYNC_OFF_STATES.has(state)) {
    throw new Error(`the Mac's Sync is not on (observed "${state}") — the harness requires the Mac to stay always-connected. Check Sync on the Mac and re-run.`);
  }
}

/**
 * Wait until the vault has SETTLED for `notes` across `drivers`: every node reports
 * `synced` (Sync's own "idle" signal) AND the full observed state (each node's
 * canonical content AND conflict-file set) has been unchanged for `settleSec`.
 * Crucially, settling does NOT require the nodes to AGREE — a stable disagreement
 * (e.g. a conflict file that only ever lands on one node, both nodes calling
 * themselves synced) is a real divergence for the oracle to judge as `-SYNCBAD`, not
 * something to wait out to the cap (which would mislabel it `-TIMEOUT`). The quiet
 * window means we never stop mid-propagation; `minFloorSec` guards the just-after-
 * connect case where a sync hasn't started yet. No blind dwell — this is the explicit
 * wait. Only a node that never reaches `synced`, or content that never stops changing,
 * actually times out.
 */
export async function waitForSynced(
  drivers: ObsidianDriver[],
  notes: string[],
  settleSec: number,
  opts: ExecuteOpts,
  logger: RunLogger,
  context: Record<string, unknown> = {},
): Promise<{ seconds: number; timedOut: boolean; unsynced: boolean; observations: NodeObservation[] }> {
  const pollMs = (opts.pollSec ?? 1) * 1000;
  const floorMs = (opts.minFloorSec ?? 3) * 1000;
  const settleMs = settleSec * 1000;
  const capMs = (opts.capSec ?? 120) * 1000;
  const probeMs = (opts.probeSec ?? 5) * 1000;
  if (notes.length === 0 || drivers.length === 0) return { seconds: 0, timedOut: false, unsynced: false, observations: [] };

  // Baseline server-version counts (the `from` reference) are read LAZILY, the first time
  // every node is synced — NOT up front. `sync:history total` blocks until the queried node has
  // caught up, so reading it on a just-reconnected, still-syncing node would stall the whole
  // settle before the bounded-probe loop even starts (full story: docs/cli-trust.md). Gate on
  // the probe instead.
  let baseline: Record<string, number> | null = null;
  let start = Date.now();
  let lastSig: string | null = null;
  let lastChange = start;
  let obs: NodeObservation[] = []; // last SYNCED snapshot; the verdict reuses it
  for (;;) {
    // 1. Bounded sync-state probe FIRST. We must NOT read content from a still-syncing node:
    //    the read blocks (~70s) AND returns mid-flux content, which fabricated a -SYNCBAD. The
    //    probe is bounded (≤ probeMs), so a not-yet-synced node reads "timeout" instead of
    //    blocking (or a genuine other status word, if the CLI actually replied with one in time).
    const tProbe = Date.now();
    const states = await Promise.all(drivers.map((d) => syncState(d, probeMs)));
    const everySynced = states.every((s) => s === "synced");
    const probeWallMs = Date.now() - tProbe;

    // 2. Only once every node is synced do we read content and re-sample the signature, so the
    //    quiet window is measured over synced, genuinely re-sampled snapshots (not a stale one).
    let sigChanged = false;
    let gatherWallMs = 0;
    if (everySynced) {
      const tGather = Date.now();
      if (baseline === null) baseline = await readTotals(drivers, notes); // synced now → fast
      obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));
      assert.equal(obs.length, drivers.length * notes.length, "settle samples every (node, note)");
      const sig = signature(notes, obs);
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); sigChanged = true; }
      gatherWallMs = Date.now() - tGather;
    }

    const now = Date.now();
    const quietMs = everySynced ? now - lastChange : 0;
    const elapsed = now - start;
    // Settled = every node `synced` AND the observed state (canonical + conflict sets) quiet for
    // the window. Convergence is NOT required — a stable, synced disagreement is a real `-SYNCBAD`
    // for the oracle, not something to wait out to the cap. floorMs covers the just-after-connect
    // gap before a sync starts.
    const done = everySynced && obs.length > 0 && quietMs >= settleMs && elapsed >= floorMs;

    // Per-poll trace so the settle's time-spend is visible: repeated states with probeMs≈cap and a
    // node reading "timeout" is genuine sync latency (the probe keeps getting killed at the cap
    // because the node genuinely isn't synced yet); a large gatherMs means a content read blocked.
    logger.log({ kind: "settle-poll", elapsedSec: Math.round(elapsed / 1000), states, everySynced, sigChanged, quietSec: Math.round(quietMs / 1000), probeMs: probeWallMs, gatherMs: gatherWallMs, ...context });

    // Cap elapsed without quiescence. Before recording a Sync timeout, rule out a HOST
    // outage: if the host can't reach the internet, the container can't sync for
    // reasons that aren't Obsidian's. Wait for connectivity to return, then restart the
    // settle window and keep waiting rather than logging a false timeout.
    if (!done && elapsed > capMs && opts.hostCheck !== false && !(await hostOnline())) {
      logger.log({ kind: "host-offline", waitingForHost: true, ...context });
      while (!(await hostOnline())) await sleep(Math.max(pollMs, 2000));
      logger.log({ kind: "host-online", resumed: true, ...context });
      start = Date.now();
      lastChange = start;
      lastSig = null;
      obs = [];
      continue;
    }
    const timedOut = !done && elapsed > capMs;
    if (done || timedOut) {
      // On a timeout before any synced snapshot, take one best-effort observation so the verdict
      // and forensics aren't empty-handed (the one place we read a node that isn't synced).
      if (obs.length === 0) obs = await Promise.all(drivers.flatMap((d) => notes.map((n) => gatherObservation(d, n))));
      // State-machine invariants: a clean settle means every node is synced AND its signature
      // held for the whole window; anything else can only exit here by hitting the cap.
      assert(everySynced || timedOut, "settle finishes only when every node is synced, or the cap elapsed");
      assert(!done || quietMs >= settleMs, "a clean settle held its signature for the full window");
      const totals = await readTotals(drivers, notes);
      baseline ??= totals; // straight-to-timeout (never synced) → no earlier baseline; use these
      const seconds = Math.round(elapsed / 1000);
      // A note with no server-side history (total < 1) never reached the server —
      // it is NOT synced however quiescent the local vault looks. Distinct from a
      // timeout (which is inconclusive); this is a hard "nothing got there".
      const unsynced = !timedOut && notes.some((n) => totals[n] < 1);
      if (timedOut) {
        // Capture each node's own sync state — a wedged node (e.g. stuck "syncing"
        // after a network reconnect) is the usual cause and is worth seeing later.
        for (const d of drivers) {
          logger.log({ kind: "status-at-timeout", node: d.node, state: await syncState(d, probeMs) });
        }
      }
      // Snapshot the settled content for the audit trail — a time series across the
      // run's W's catches a token that vanished then recovered before the final check
      // (which only ever sees the end state). When all nodes agree on a note, log ONE
      // `converged:true` row instead of one-per-node so the reader isn't left diffing
      // identical rows; only a real divergence is broken out per node.
      for (const note of notes) {
        const g = obs.filter((o) => o.note === note);
        const first = g[0];
        const allEqual = first != null && g.every((o) =>
          (o.canonical ?? null) === (first.canonical ?? null) && sameConflictSet(o.conflicts, first.conflicts));
        if (allEqual) {
          logger.log({ kind: "content-at-wait", note, converged: true, canonical: first.canonical, conflicts: first.conflicts, ...context });
        } else {
          for (const o of g) logger.log({ kind: "content-at-wait", note, node: o.node, converged: false, canonical: o.canonical, conflicts: o.conflicts, ...context });
        }
      }
      for (const n of notes) {
        const kind = timedOut ? "sync-timeout" : totals[n] < 1 ? "unsynced" : "synced";
        logger.log({ kind, note: n, from: baseline[n], to: totals[n], seconds, ...context });
      }
      // Return THIS observation (the one that satisfied `done`): its signature held
      // unchanged across the whole settle window, so it's confirmed across many reads.
      // Callers must use it rather than a fresh re-read — a single `files` listing can
      // transiently drop a conflict file and fabricate a "loss".
      return { seconds, timedOut, unsynced, observations: obs };
    }
    await sleep(pollMs);
  }
}

/**
 * Independent FS second-source check at the SETTLED verdict: the set of `.md` files the CLI
 * reports in `folder` must EXACTLY match what's actually on disk (`ls`). A file the CLI
 * reports that the FS lacks is the forum "conflict file was never really created" bug; a file
 * on disk the CLI omits is the empty-listing bug docs/cli-trust.md opens with. Either way →
 * ALARM. Skipped when the driver has no vault path (local/dev). Run only once settled, so a
 * mid-sync difference can't fire.
 */
export async function crossCheckFs(drivers: ObsidianDriver[], folder: string): Promise<void> {
  for (const d of drivers) {
    const fs = await d.listDirFs(folder);
    if (!fs.ok && fs.reason === "unavailable") continue; // no FS path configured for THIS driver → skip it, not the rest
    const cli = new Set((await d.listFiles(folder)).value ?? []);
    const onDisk = new Set((fs.ok ? fs.entries : []).map((e) => `${folder}/${e}`));
    const cliReportedButNotOnDisk = [...cli].filter((x) => !onDisk.has(x));
    const onDiskButNotReported = [...onDisk].filter((x) => !cli.has(x));
    if (cliReportedButNotOnDisk.length || onDiskButNotReported.length) {
      throw new AlarmError("cli-fs-disagreement", {
        node: d.node, folder,
        cliReportedButNotOnDisk: cliReportedButNotOnDisk.slice(0, 10), cliOnlyCount: cliReportedButNotOnDisk.length,
        onDiskButNotReported: onDiskButNotReported.slice(0, 10), fsOnlyCount: onDiskButNotReported.length,
      });
    }
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
    const states = await Promise.all(drivers.map(async (d) => (await d.syncStatus()).value ?? "?"));
    if (states.every((s) => s === "synced")) {
      const notes = await Promise.all(drivers.map(async (d) => (await d.listFiles()).value?.length ?? 0));
      logger.log({ kind: "baseline-synced", states, notes });
      return;
    }
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
  logger.log({
    kind: "history", string: str, ops: history,
    // Every configured driver's own id (e.g. ["n1","n2"], or [...,"HMMBP.local"] with the Mac) —
    // recorded so a rep that never happens to touch every configured node still shows what was
    // actually live during it (a history's own `ops` only shows what it selected, not the full
    // topology it ran against).
    nodes: drivers.map((d) => d.node),
    isolator: opts.isolator, obsidianVersion: opts.obsidianVersion, macObsidianVersion: opts.macObsidianVersion,
    wSettleSec: opts.wSettleSec ?? 4, finalSettleSec: opts.finalSettleSec ?? 15,
    pollSec: opts.pollSec ?? 1, minFloorSec: opts.minFloorSec ?? 3,
    capSec: opts.capSec ?? 120, probeSec: opts.probeSec ?? 5,
  });

  // Route the driver's cli-unresponsive (wait-for-recovery) events, and the isolator's own
  // internal network-reachability retries, into this rep's trace.
  for (const d of drivers) d.onEvent = (e) => logger.log(e);
  isolator.onEvent = (e) => logger.log(e);

  // No `sync on` here: the network isolator (the default fault primitive) never calls `sync
  // off`, so resuming would be an unforced call with nothing to undo. `preflight()` already
  // resumed once at harness startup (the real one-time paused state after `make containers-up`);
  // Sync stays on for the whole session from there.
  // Start from a known-clean baseline: don't begin editing until every node is synced.
  await waitNodesSynced(drivers, opts.capSec ?? 120, logger);

  const driverOf = (num: number) => drivers[num - 1];

  let activeNode = 1;
  let activeNote: string | undefined;
  const offline = new Set<number>(); // node numbers currently network-disconnected
  const touched = new Set<string>(); // concrete note names seen this run
  const noteLetters = new Map<string, string>(); // concrete note name -> its logical DSL letter
  const acked: AckedEdit[] = [];
  let seq = 0;
  // Per-call cap for any mid-history bounded sync-state probe (pause snapshots), same knob and
  // rationale as the settle's own probe: never block on a not-yet-synced node.
  const probeMs = (opts.probeSec ?? 5) * 1000;

  // NOTE: scripts/repro-lib.sh reimplements a simplified version of this op interpreter in bash,
  // for `make repro`'s standalone reproduction scripts (see src/repro.ts). If you change how an
  // op behaves here (append's create-vs-append fallback, disconnect/connect, what counts as
  // "synced", the token format), check whether scripts/repro-lib.sh needs the same update.
  for (const op of history) {
    switch (op.cmd) {
      case "node":
        activeNode = op.node!;
        break;
      case "mac":
        // opts.macNode is the Mac driver's own position within `drivers` (run.ts appends it
        // last) — from here on it's indistinguishable from any other numbered node to the
        // rest of this function, except D/C refuse it (see the asserts below).
        activeNode = opts.macNode!;
        break;
      case "pause": {
        // Logged at START: a pause has no result to report beyond "I did the thing" (just the
        // requested duration, echoed — no measured outcome), unlike pause-snapshot below, which
        // DOES carry a real result and stays logged at its own finish.
        logger.log({ kind: "pausing", seconds: op.seconds });
        await sleep((op.seconds ?? DEFAULT_PAUSE_SEC) * 1000);
        // Snapshot every node (not just the active one — the whole point is seeing what a
        // DISCONNECTED node's own local state looks like during a D…P…C window, invisible
        // otherwise until the final settle). A snapshot is a LOOK, not a judgment: every call
        // is a single bounded attempt via the driver's snapshot* methods — never the paranoid,
        // retrying read()/files()/listDirFs() the oracle uses. A wedged or unrecognized reply
        // is recorded as-is, never chased, so a snapshot can never itself stall the harness.
        //
        // `NOTE_DIR` accumulates every rep of a soak, so a bare folder listing is mostly
        // OTHER reps' notes. Scope both listings down to files that belong to THIS rep: an
        // entry is relevant iff it's exactly one of our touched notes, or a "(Conflicted
        // copy ...)" of one. `fs` entries are bare filenames (a raw `ls` inside the folder);
        // `files` entries carry the NOTE_DIR/ prefix (the CLI's own vault-relative paths).
        const touchedList = [...touched];
        const noteBase = (fullname: string) => fullname.slice(NOTE_DIR.length + 1); // strip "bughunt/"
        const isRelevant = (entry: string, base: string) => entry === `${base}.md` || entry.startsWith(`${base} (Conflicted copy`);
        // A synced node's sync:status replies quickly; an unsynced one blocks for the WHOLE
        // budget regardless (it never returns early with a "syncing" word — see
        // syncStateProbe), so a short cap here just makes that wasted wait cheap. Separate from
        // the settle's own probeMs (unchanged, different concern).
        const SNAPSHOT_SYNC_PROBE_MS = 1000;
        // Debug/observability aid: time each call individually (useful for spotting a slow
        // snapshot call), without affecting their concurrency. Default on; --skip-snapshot-timing
        // (opts.snapshotTiming === false) drops the `ms` fields with no other code change.
        const mkTimed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms?: number }> => {
          const t0 = Date.now();
          const value = await fn();
          return { value, ms: opts.snapshotTiming === false ? undefined : Date.now() - t0 };
        };
        const nodesSnapshot = await Promise.all(
          drivers.map(async (d) => {
            const [syncT, fsT, filesT, notesT] = await Promise.all([
              mkTimed(() => syncState(d, SNAPSHOT_SYNC_PROBE_MS)),
              mkTimed(() => d.snapshotFs(NOTE_DIR, probeMs)),
              mkTimed(() => d.snapshotFiles(NOTE_DIR, probeMs)),
              Promise.all(touchedList.map(async (fullname) => {
                const { value: r, ms } = await mkTimed(() => d.snapshotRead(fullname, probeMs));
                return [noteLetters.get(fullname) ?? fullname, ms !== undefined ? { ...r, ms } : r] as const;
              })),
            ]);
            const fsRelevant = (fsT.value.entries ?? []).filter((e) => touchedList.some((f) => isRelevant(e, noteBase(f))));
            const filesRelevant = (filesT.value.entries ?? []).filter((e) => touchedList.some((f) => isRelevant(e, f)));
            // Conflict-file NAMES only (from the one `files` call — cheap, bounded, no
            // per-file follow-up reads); their content is what the settle-time oracle judges.
            const conflicts = filesRelevant.filter(isConflictFile);
            return {
              node: d.node,
              sync: syncT.ms !== undefined ? { state: syncT.value, ms: syncT.ms } : syncT.value,
              fs: { status: fsT.value.status, entries: fsRelevant, ...(fsT.ms !== undefined ? { ms: fsT.ms } : {}) },
              files: { status: filesT.value.status, conflicts, ...(filesT.ms !== undefined ? { ms: filesT.ms } : {}) },
              notes: Object.fromEntries(notesT),
            };
          }),
        );
        logger.log({ kind: "pause-snapshot", seconds: op.seconds, nodes: nodesSnapshot });
        break;
      }
      case "disconnect":
        // Defense-in-depth: dsl.ts's assertMacAlwaysConnected already makes this unreachable
        // via any real history, but never trust a single layer for "never disconnect the Mac".
        assert(activeNode !== opts.macNode, "the Mac node must never be disconnected");
        // Logged at START: no result of its own beyond "I did the thing" — the actual outcome
        // (each reachability attempt, and how long it took) is network-probe's job, at ITS finish.
        logger.log({ kind: "disconnecting", node: driverOf(activeNode).node });
        await isolator.disconnect(driverOf(activeNode).node);
        offline.add(activeNode);
        break;
      case "connect":
        assert(activeNode !== opts.macNode, "the Mac node must never be disconnected");
        logger.log({ kind: "connecting", node: driverOf(activeNode).node });
        await isolator.connect(driverOf(activeNode).node);
        offline.delete(activeNode);
        break;
      case "wait": {
        if (!activeNote) break; // nothing selected to wait on
        // W is the active node's OWN view — a user at that node only knows what their own
        // client reports, not what other nodes/the network are seeing (that whole-system
        // "god's-eye" check is what the FINAL settle is for, across every node and note).
        // A W on a disconnected node can't make progress — NOP it rather than block.
        // (waitForSynced is also hard-bounded by capSec, so a W never hangs even online.)
        if (offline.has(activeNode)) {
          logger.log({ kind: "wait-skip", node: driverOf(activeNode).node, note: activeNote, reason: "offline" });
          break;
        }
        if (activeNode === opts.macNode) await assertMacSyncOn(driverOf(activeNode), opts);
        await waitForSynced([driverOf(activeNode)], [activeNote], opts.wSettleSec ?? 4, opts, logger, { wait: driverOf(activeNode).node });
        break;
      }
      case "append": {
        if (activeNode === opts.macNode) await assertMacSyncOn(driverOf(activeNode), opts);
        const noteLetter = op.note!;
        activeNote = opts.noteName(noteLetter); // logical letter -> concrete vault note (also the W target)
        touched.add(activeNote);
        noteLetters.set(activeNote, noteLetter);
        const d = driverOf(activeNode);
        const token = formatToken({ node: d.node, seq: ++seq, note: noteLetter });
        // Exit codes are meaningless (the CLI always exits 0) and append-to-missing
        // silently no-ops, so an edit is only acked after its token is read back
        // locally. If it doesn't land, retry a few times (logging each miss as
        // `edit-unconfirmed`) rather than silently dropping it. Each attempt re-reads
        // first: if the token is already present, a prior attempt landed and a flaky
        // read just hid it — stop, so we never double-append (which would trip the
        // duplication oracle). The happy path logs no extra field — just the op.
        const MAX_ATTEMPTS = 3;
        let landed = false;
        let created = false;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !landed; attempt++) {
          const before = await d.read(activeNote);
          if (before.ok && (before.value ?? "").includes(token)) { landed = true; break; }
          // Create if THIS node doesn't have the note locally yet, else append. So
          // editing before propagation is a natural create-create; after, it's
          // append-contention — timing decides, no forced sync. `before.ok` = present.
          const exists = before.ok;
          created = !exists;
          // Foreground the note on the EDITING node before each edit — the active
          // node changes via `N` without re-selecting, so opening here (not just on
          // select) makes the GUI follow whichever node is actually writing.
          if (exists) { await d.open(activeNote); await d.appendLine(activeNote, token); }
          else { await d.createNote(activeNote, token); await d.open(activeNote); }
          const back = await d.read(activeNote);
          landed = back.ok && (back.value ?? "").includes(token);
          if (!landed) logger.log({ kind: "edit-unconfirmed", node: d.node, note: noteLetter, token, attempt, fullname: activeNote });
        }
        if (landed) {
          // Always `appended` so the log mirrors the history; `created` marks a create-create
          // (conflict genesis). The noisy exploded name trails as `fullname`.
          logger.log({ kind: "appended", node: d.node, note: noteLetter, token, created, fullname: activeNote });
          acked.push({ note: activeNote, node: d.node, token });
        } else {
          logger.log({ kind: "edit-failed", node: d.node, note: noteLetter, token, attempts: MAX_ATTEMPTS, fullname: activeNote });
        }
        break;
      }
    }
  }

  // Final settle: reconnect everyone (no `sync on` — see the rep-start comment above: the
  // network isolator never turns sync off, so there's nothing to resume), wait until all
  // agree, then dwell (conflict files lag) before observing.
  for (const num of offline) {
    logger.log({ kind: "connecting", node: driverOf(num).node });
    await isolator.connect(driverOf(num).node);
  }
  offline.clear();
  const noteList = [...touched];
  // Final settle: wait until the whole vault (canonical + conflict files) is
  // converged and quiescent for the long window — explicitly waiting out the
  // conflict file's own ~2-round-trip sync rather than dwelling blindly.
  const stab = await waitForSynced(drivers, noteList, opts.finalSettleSec ?? 15, opts, logger, { final: true });

  // Judge from the settle's window-confirmed observation, NOT a fresh re-read: a single
  // `files folder=…` listing can transiently omit a conflict file, which would fabricate
  // a "loss" for edits that are actually preserved in that file (docs/cli-trust.md's founding
  // incident, same failure mode).
  const observations = stab.observations;
  // Independent FS second-source: at this settled point, what the CLI lists under bughunt/
  // must exactly match what's on disk — or ALARM (catches phantom/never-written conflict
  // files and listing dropouts alike).
  await crossCheckFs(drivers, NOTE_DIR);
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
  logger.log({ kind: "results", history: str, timings, acked, observations, verdict, forensics, noteLetters: Object.fromEntries(noteLetters) });
  return { verdict, acked, observations, timings, forensics };
}
