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
import { CliInconsistencyError } from "./inconsistency.js";
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
import { FileLane } from "./timeline.js";
import { historyDurationExpectedMinSec } from "./floor.js";
import { ArrivalTracker } from "./arrivals.js";

export interface ExecuteOpts {
  noteName: (letter: string) => string; // DSL note letter -> concrete vault note name (per-rep)
  pollSec?: number; // observation poll cadence (default 1)
  minFloorSec?: number; // observe at least this long (catches slow-to-start syncs after C; default 3)
  // How long to wait, once not-yet-done, before ALSO checking whether the host itself might be
  // offline (default 120) — see waitForSynced. Sync itself is an uncontrollable, necessary
  // external resource: there is no principled point at which "it's been a while" means "it's
  // never coming", so this is NOT a give-up deadline — waitForSynced/waitNodesSynced/preflight()
  // all wait unboundedly for a real settle. Every step is still logged (settle-poll), so an
  // unusually long rep is visible after the fact (e.g. by comparing timings across a history's
  // reps), just never aborted mid-flight.
  capSec?: number;
  // Settled = every node reports `synced`, the observed state (canonical + conflicts) has been
  // unchanged for this window, AND every node agrees on it. A stable DISAGREEMENT does not
  // finish here — see waitForSynced's own doc comment for why. The window absorbs a
  // just-lagging conflict file; keep it short since `synced` already means "Sync is idle".
  finalSettleSec?: number; // final settle: quiescent-for window (default 15)
  // Per-call cap on the settle's `sync:status` probe (default 5). `sync:status` blocks until
  // synced, so this bounds it into a pollable "synced yet?" — a timeout means "still syncing".
  // Must stay comfortably above a synced node's instant reply, well below the settle window.
  probeSec?: number;
  // Once capSec has elapsed without a settle, tell a Sync failure apart from a host-internet
  // outage: if the host itself is offline, wait for connectivity to return and restart the
  // window instead of recording a false timeout. Disabled by --skip-host-check — a sandbox with
  // no outbound TCP would otherwise treat this as a permanent outage and wait forever anyway
  // (which is often still the right call, just with less useful logging). Default on.
  hostCheck?: boolean;
  // Whether the "pause" case's whole snapshot mechanism runs at all (see the "pause" case) — a
  // real bounded CLI call per driver per touched note, purely diagnostic. Default ON;
  // --skip-snapshot turns it fully off, in case it's suspected of perturbing timings/results
  // (the same methodological caution that used to govern the retired would-fail peek).
  snapshot?: boolean;
  // Recorded into the `history` event only — neither changes execution here. A rep's
  // outcome can depend on which of these governed it (confirmed: the isolator choice alone
  // flips whether a concurrent-create collision produces a conflict file), so both need to
  // travel WITH the rep's own trace, not just live in the invocation's separate run log.
  isolator?: string; // "network" | "sync" — which fault primitive drove this run's D/C
  obsidianVersion?: string; // the CLI's own self-reported version, queried once at startup
  // The container engine's own self-report (`<engine> --version`), same reasoning as the line
  // above: the engine is part of the stack under test, not neutral scaffolding — it decides how
  // fast a `D`/`C` actually detaches and reattaches the node (see scripts/check-net.sh), so a
  // finding has to carry it.
  containerEngine?: string;
  // The local instance (DSL `L`), when configured: its 1-based position within `drivers` (it's
  // just another element of that array, always last — see run.ts) and its own self-reported
  // Obsidian version (likely different from the containers' pinned build, which is the whole
  // point of testing against it). Purely a construction-time detail — used once, inside
  // runHistory, to get a direct `localDriver` reference; NOT the DSL's own addressing scheme
  // (N<d> always resolves by container NAME, see driverOf — it can never reach this driver).
  // Undefined means no local instance is configured.
  localNode?: number;
  localObsidianVersion?: string;
  // Captured once at startup (`vault info=name`, before any rep runs) — the baseline
  // assertLocalVaultUnchanged compares against on every op that touches the local node.
  // Undefined means it couldn't be captured, so the check below never fires (see run.ts).
  localVaultName?: string;
  // Overridable so tests don't wait the real 5s worst case — see assertLocalVaultUnchanged.
  vaultRecheckMs?: number;
  // Overridable so tests don't wait the real ~15s worst case — see assertLocalSyncOn.
  localSyncGraceMs?: number;
  localSyncGraceAttempts?: number;
  // Once `W` has seen the server version counter move but the tokens are still not on this node's
  // disk, how long to let Sync fix it before the history is abandoned as a loss. This is NOT
  // patience with a slow sync — case A, where nothing has moved at all, is unbounded. It is the
  // grace given to a discrepancy that is already visible.
  lossGraceSec?: number;
  // How much to look at while waiting.
  //
  // `strategic` (default) samples only what a wait needs to decide, which is the right default: the
  // instrument must not perturb Sync. Its cost is that most lanes of a reconstructed timeline are
  // blank, and that arrivals come back overwhelmingly left-censored (1076 of 1081 in the corpus —
  // the first look at a receiver lands a median of 11.2s after the append, against a ~5s delivery).
  //
  // `everything` samples every node × every touched note on every poll, probe-style, so the
  // timeline is dense and arrivals are actually resolved. It DOES perturb what it measures; it is
  // for answering a question, not for soaking. `everything-no-sleep` additionally drops the poll
  // delay and samples as fast as the calls return.
  sampling?: "strategic" | "everything" | "everything-no-sleep";
  // Foreground the note on the editing node before each edit, so a watching human sees the GUI
  // follow whichever node is writing. OFF by default: it is a round trip per edit spent purely on
  // presentation, and it is not free of consequence — opening a note is something a real user does,
  // and whether Sync treats an open note differently is an open question this harness has not
  // settled. Turn it on to watch, not to measure.
  openNotes?: boolean;
  runsDir?: string;
}

export interface LostForensic {
  note: string;
  token: string;
  writer: NodeId; // the node whose edit was lost (from AckedEdit)
  inServer: boolean; // present in server history despite being gone from the vault
  serverVersions: number[];
  // Did the writer's own device leave behind ANY conflict file for this note? Per the confirmed
  // model (see lostForensics's doc comment), a lost token can never itself appear inside a
  // conflict file — false here means the writer's client never even attempted to preserve its
  // diverging content for this note, i.e. it silently discarded its own edit.
  conflictFileFound: boolean;
}

export interface RunResult {
  verdict: RunVerdict;
  acked: AckedEdit[];
  observations: NodeObservation[];
  timings: { totalSec: number; convergenceSec: number; unsynced: boolean; hostOutage: boolean; vaultDrift: boolean };
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

/** Whether every driver's observation for `note` agrees — same canonical content AND the same
 *  conflict-file set. Required (alongside `everySynced` + quiet) before the settle accepts a
 *  state as truly "done" — see waitForSynced. */
function noteConverged(note: string, obs: NodeObservation[]): { first: NodeObservation | undefined; allEqual: boolean } {
  const g = obs.filter((o) => o.note === note);
  const first = g[0];
  const allEqual = first != null && g.every((o) =>
    (o.canonical ?? null) === (first.canonical ?? null) && sameConflictSet(o.conflicts, first.conflicts));
  return { first, allEqual };
}
function allNotesConverged(notes: string[], obs: NodeObservation[]): boolean {
  return notes.every((note) => noteConverged(note, obs).allEqual);
}

/** A node's own sync state via the BOUNDED probe, e.g. "synced" / "syncing" / "timeout" (killed
 *  before a reply came back — not positively confirmed as any specific state) / "?" (unreadable).
 *  Bounded so the settle loop polls instead of blocking ~70s on `sync:status` (which would
 *  straddle the quiescence window and fabricate a false divergence — see waitForSynced). */
async function syncState(d: ObsidianDriver, probeMs: number): Promise<string> {
  return d.syncStateProbe(probeMs);
}

const HOST_RECHECK_MS = 5_000; // recheck host connectivity every 5s while it's down

/** If the host (the machine running the harness — not any node) is currently offline, wait for
 *  it to come back, logging each phase: host-offline (start), host-reconnect-probe (each retry,
 *  while still down), host-online (recovered). Unbounded — an internet outage isn't a Sync
 *  problem, so we wait it out rather than manufacture a failure. Returns whether it actually had
 *  to wait (false = host was already online, a no-op). */
async function waitForHostReconnect(logger: RunLogger, context: Record<string, unknown> = {}): Promise<boolean> {
  if (await hostOnline()) return false;
  logger.log({ kind: "host-offline", ...context });
  for (let attempt = 1; ; attempt++) {
    await sleep(HOST_RECHECK_MS);
    const online = await hostOnline();
    logger.log({ kind: "host-reconnect-probe", attempt, online, ...context });
    if (online) break;
  }
  logger.log({ kind: "host-online", ...context });
  return true;
}

/** The local instance has no network-level isolation (see dsl.ts's assertLocalAlwaysConnected) —
 *  its Sync being on is the whole load-bearing assumption of testing against it. Checked before
 *  every op that actually touches it (append/wait), using the same bounded, non-blocking probe
 *  the settle uses. Only a POSITIVELY-read off-state is treated as a problem; a probe
 *  "timeout"/"?" (inconclusive, e.g. mid-sync) is tolerated — never manufacture a failure from an
 *  inconclusive bounded probe (same philosophy as syncStateProbe itself).
 *
 *  A positively-read off-state gets one more chance before aborting: it's often just the local
 *  symptom of the HOST losing its own internet — wait for connectivity to return (unbounded, same
 *  as the settle loop) if it's CURRENTLY offline, then unconditionally give Sync a short grace
 *  window to recover before giving up for real. That grace window is NOT contingent on actually
 *  catching an active outage: a brief blip can easily have already ended by the time this probe
 *  runs (this only fires at rep-start and before append/wait ops, not continuously), leaving Sync
 *  itself still a moment behind clearing its own error state even though connectivity is already
 *  back — that case still deserves the same grace. Only if it's STILL off after that does this
 *  throw a plain Error (not CliInconsistencyError): Sync genuinely off invalidates every
 *  subsequent rep until a human fixes it, so this must escape runRep's per-rep catch and abort
 *  the whole soak, not just tag one rep -OBSFAIL. Returns whether either detour actually
 *  happened (so the caller can flag this rep's timings as unreliable even if it goes on to finish
 *  normally). */
const LOCAL_SYNC_OFF_STATES = new Set(["paused", "error", "stopped", "offline"]);
const LOCAL_SYNC_GRACE_ATTEMPTS = 3;
const LOCAL_SYNC_GRACE_MS = 5_000;
async function assertLocalSyncOn(driver: ObsidianDriver, opts: ExecuteOpts, logger: RunLogger): Promise<boolean> {
  const probeMs = (opts.probeSec ?? 5) * 1000;
  let state = await syncState(driver, probeMs);
  let hostOutage = false;
  if (LOCAL_SYNC_OFF_STATES.has(state) && opts.hostCheck !== false) {
    hostOutage = await waitForHostReconnect(logger, { node: driver.node }); // waits out an ACTIVE outage, if any
    const graceMs = opts.localSyncGraceMs ?? LOCAL_SYNC_GRACE_MS;
    const graceAttempts = opts.localSyncGraceAttempts ?? LOCAL_SYNC_GRACE_ATTEMPTS;
    for (let i = 0; i < graceAttempts && LOCAL_SYNC_OFF_STATES.has(state); i++) {
      hostOutage = true; // any grace retry means this rep waited extra recovery time — flag it either way
      await sleep(graceMs);
      state = await syncState(driver, probeMs);
    }
  }
  if (LOCAL_SYNC_OFF_STATES.has(state)) {
    throw new Error(`the local node's Sync is not on (observed "${state}") — the harness requires it to stay always-connected. Check Sync on ${driver.node} and re-run.`);
  }
  return hostOutage;
}

const VAULT_RECHECK_MS = 5_000; // recheck every 5s while the active vault doesn't match

/** `obsidian-cli` acts on whatever vault is currently active in the GUI, not one the harness
 *  pins by name — if a human (or Obsidian itself) switches vaults mid-soak, every subsequent
 *  local-node read/write silently targets the wrong data. Checked at the same points as
 *  `assertLocalSyncOn`: once per rep, and before every op that actually touches the local node.
 *  Only a POSITIVELY-read, DIFFERENT name is a problem — a probe timeout/unrecognized reply is
 *  tolerated, same "never manufacture a failure from an inconclusive bounded probe" philosophy
 *  as everywhere else in this file.
 *
 *  A mismatch does NOT abort: which vault is active is a human/GUI-controlled condition, not a
 *  Sync problem — same reasoning as `waitForHostReconnect`. Wait it out instead, unbounded,
 *  rechecking every `vaultRecheckMs` (default 5s) until the expected vault is confirmed active
 *  again, logging each phase (`local-vault-changed`, `local-vault-recheck` per attempt,
 *  `local-vault-restored`). Returns whether it ever had to wait, so the caller can flag this
 *  rep's timings as unreliable even though it goes on to finish normally. */
async function assertLocalVaultUnchanged(driver: ObsidianDriver, opts: ExecuteOpts, logger: RunLogger): Promise<boolean> {
  if (opts.localVaultName === undefined) return false; // nothing captured at startup — can't check
  const probeMs = (opts.probeSec ?? 5) * 1000;
  const recheckMs = opts.vaultRecheckMs ?? VAULT_RECHECK_MS;
  let r = await driver.vaultNameProbe(probeMs);
  if (r.status !== "ok" || r.name === opts.localVaultName) return false;
  logger.log({ kind: "local-vault-changed", node: driver.node, expected: opts.localVaultName, observed: r.name });
  for (;;) {
    await sleep(recheckMs);
    r = await driver.vaultNameProbe(probeMs);
    const back = r.status === "ok" && r.name === opts.localVaultName;
    logger.log({ kind: "local-vault-recheck", node: driver.node, observed: r.status === "ok" ? r.name : r.status, back });
    if (back) break;
  }
  logger.log({ kind: "local-vault-restored", node: driver.node });
  return true;
}

/**
 * Wait until the vault has SETTLED for `notes` across `drivers`: every node reports
 * `synced` (Sync's own "idle" signal), the full observed state (each node's canonical
 * content AND conflict-file set) has been unchanged for `settleSec`, AND every node
 * AGREES on it. That last requirement is deliberate: a STABLE DISAGREEMENT (both
 * nodes calling themselves synced, content quiet, but disagreeing, no conflict file)
 * would be a genuinely catastrophic Obsidian bug if it were truly permanent — far
 * more likely, `sync:status` said "synced" before a real round-trip actually
 * finished. So this never finalizes on a disagreement; it keeps polling, which
 * already re-samples real content (not just the `sync:status` word) every cycle —
 * enough to notice a later real resolution (a merge, or a conflict file appearing)
 * whenever it actually happens. This does NOT block genuine loss detection: a token
 * that's truly, permanently gone from every node reads as CONVERGED (everyone
 * agrees it's absent) — only an active node-vs-node disagreement fails to converge.
 *
 * There is no give-up deadline. Sync is an uncontrollable, necessary external
 * resource — there's no principled point at which "it's been a while" means "it's
 * never coming". Every poll is logged (`settle-poll`), so an unusually long rep is
 * still visible after the fact (e.g. comparing timings across a history's reps),
 * just never aborted mid-flight. `minFloorSec` guards the just-after-connect gap
 * before a sync has started; `capSec` only gates when to ALSO start checking
 * whether the HOST itself is offline (a different question from Sync's own
 * health) — not a deadline of its own.
 */
export async function waitForSynced(
  drivers: ObsidianDriver[],
  notes: string[],
  settleSec: number,
  opts: ExecuteOpts,
  logger: RunLogger,
  context: Record<string, unknown> = {},
  // Optional: fed the observation this loop already makes, so a token's arrival on another node is
  // dated at the moment it is seen. Never consulted — it only records (see src/arrivals.ts).
  arrivals?: ArrivalTracker,
  sampleAll?: () => Promise<void>,
  // Optional: fed the same observation, to log it as a `sample`. Set only when `sampleAll` is not,
  // so exactly one of the two writes a node's file lane in any given poll.
  noteObserved?: (o: NodeObservation, ms: number) => void,
): Promise<{ seconds: number; unsynced: boolean; observations: NodeObservation[]; hostOutage: boolean }> {
  const pollMs = opts.sampling === "everything-no-sleep" ? 0 : (opts.pollSec ?? 1) * 1000;
  const floorMs = (opts.minFloorSec ?? 3) * 1000;
  const settleMs = settleSec * 1000;
  const capMs = (opts.capSec ?? 120) * 1000;
  const probeMs = (opts.probeSec ?? 5) * 1000;
  if (notes.length === 0 || drivers.length === 0) {
    return { seconds: 0, unsynced: false, observations: [], hostOutage: false };
  }

  // Baseline server-version counts (the `from` reference) are read LAZILY, the first time
  // every node is synced — NOT up front. `sync:history total` blocks until the queried node has
  // caught up, so reading it on a just-reconnected, still-syncing node would stall the whole
  // settle before the bounded-probe loop even starts (full story: docs/cli-trust.md). Gate on
  // the probe instead.
  let baseline: Record<string, number> | null = null;
  const start0 = Date.now();
  let start = start0;
  let lastSig: string | null = null;
  let lastChange = start;
  let obs: NodeObservation[] = []; // last SYNCED snapshot; the verdict reuses it
  let hostOutage = false;
  for (;;) {
    // Fired, not awaited — same reasoning as in waitOnNode: overlap the sampler with this poll's
    // own reads instead of paying for both in series.
    const sampling = sampleAll?.().catch(() => {});
    // 1. Bounded sync-state probe FIRST. We must NOT read content from a still-syncing node:
    //    the read blocks (~70s) AND returns mid-flux content, which fabricated a divergence. The
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
      // Free: `obs` is already in hand, so dating an arrival costs no read and perturbs no timing.
      arrivals?.observe(obs, logger);
      // One `Promise.all` gathers every (node, note), so they share its wall time — the same
      // convention as the sampler's round.
      const thisGatherMs = Date.now() - tGather;
      if (noteObserved) for (const o of obs) noteObserved(o, thisGatherMs);
      const sig = signature(notes, obs);
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); sigChanged = true; }
      gatherWallMs = Date.now() - tGather;
    }
    await sampling;

    const now = Date.now();
    const quietMs = everySynced ? now - lastChange : 0;
    const elapsed = now - start;
    // Settled = every node `synced`, the observed state (canonical + conflict sets) quiet for the
    // window, AND every node agrees on it — see this function's own doc comment for why
    // convergence is required, not just stability. floorMs covers the just-after-connect gap
    // before a sync starts.
    const done = everySynced && obs.length > 0 && quietMs >= settleMs && elapsed >= floorMs && allNotesConverged(notes, obs);

    // Per-poll trace so the settle's time-spend is visible: repeated states with probeMs≈cap and a
    // node reading "timeout" is genuine sync latency (the probe keeps getting killed at the cap
    // because the node genuinely isn't synced yet); a large gatherMs means a content read blocked.
    logger.log({
      // `nodes` parallels `states`: without it a reconstruction has a row of sync states and no way
      // to say whose they are. The mid-history wait logs a single `wait` node for the same reason.
      kind: "settle-poll", elapsedSec: Math.round(elapsed / 1000), nodes: drivers.map((dd) => dd.node), states, everySynced, sigChanged,
      quietSec: Math.round(quietMs / 1000), probeMs: probeWallMs, gatherMs: gatherWallMs, ...context,
    });

    // Once we've been waiting a while, ALSO rule out a HOST outage before continuing to poll: if
    // the host can't reach the internet, the container can't sync for reasons that aren't
    // Obsidian's. Wait for connectivity to return, then restart the window and keep waiting.
    if (!done && elapsed > capMs && opts.hostCheck !== false) {
      if (await waitForHostReconnect(logger, context)) {
        hostOutage = true;
        start = Date.now();
        lastChange = start;
        lastSig = null;
        obs = [];
        continue;
      }
    }
    if (done) {
      const totals = await readTotals(drivers, notes);
      assert(baseline !== null, "done implies at least one everySynced pass, which sets baseline");
      const seconds = Math.round(elapsed / 1000);
      // A note with no server-side history (total < 1) never reached the server — it is NOT
      // synced however quiescent the local vault looks. A real, standalone finding.
      const unsynced = notes.some((n) => totals[n] < 1);
      assert(quietMs >= settleMs, "a clean settle held its signature for the full window");
      // Snapshot the settled content for the audit trail — a time series across the
      // run's W's catches a token that vanished then recovered before the final check
      // (which only ever sees the end state). When all nodes agree on a note, log ONE
      // `converged:true` row instead of one-per-node so the reader isn't left diffing
      // identical rows; only a real divergence is broken out per node.
      for (const note of notes) {
        const { first, allEqual } = noteConverged(note, obs);
        if (allEqual) {
          logger.log({ kind: "content-at-wait", note, converged: true, canonical: first!.canonical, conflicts: first!.conflicts, ...context });
        } else {
          for (const o of obs.filter((x) => x.note === note)) logger.log({ kind: "content-at-wait", note, node: o.node, converged: false, canonical: o.canonical, conflicts: o.conflicts, ...context });
        }
      }
      for (const n of notes) {
        const kind = totals[n] < 1 ? "unsynced" : "synced";
        logger.log({ kind, note: n, from: baseline[n], to: totals[n], seconds, ...context });
      }
      // Return THIS observation (the one that satisfied `done`): its signature held
      // unchanged across the whole settle window, so it's confirmed across many reads.
      // Callers must use it rather than a fresh re-read — a single `files` listing can
      // transiently drop a conflict file and fabricate a "loss".
      return { seconds, unsynced, observations: obs, hostOutage };
    }
    if (pollMs > 0) await sleep(pollMs);
  }
}

/**
 * Independent FS second-source check at the SETTLED verdict: the set of `.md` files the CLI
 * reports in `folder` must EXACTLY match what's actually on disk (`ls`). A file the CLI
 * reports that the FS lacks is the forum "conflict file was never really created" bug; a file
 * on disk the CLI omits is the empty-listing bug docs/cli-trust.md opens with. Either way →
 * a flagged inconsistency. Skipped when the driver has no vault path (local/dev). Run only once settled, so a
 * mid-sync difference can't fire.
 */
export async function crossCheckFs(drivers: ObsidianDriver[], folder: string, logger?: RunLogger): Promise<void> {
  for (const d of drivers) {
    const t0 = Date.now();
    const fs = await d.listDirFs(folder);
    if (!fs.ok && fs.reason === "unavailable") continue; // no FS path configured for THIS driver → skip it, not the rest
    const cli = new Set((await d.listFiles(folder)).value ?? []);
    // Logged even when it agrees. A check that reads two sources and says nothing unless it is
    // unhappy leaves its own cost — and the fact that it ran at all — invisible.
    logger?.log({ kind: "cross-check", what: "listing", node: d.node, folder, files: cli.size, ms: Date.now() - t0 });
    const onDisk = new Set((fs.ok ? fs.entries : []).map((e) => `${folder}/${e}`));
    const cliReportedButNotOnDisk = [...cli].filter((x) => !onDisk.has(x));
    const onDiskButNotReported = [...onDisk].filter((x) => !cli.has(x));
    if (cliReportedButNotOnDisk.length || onDiskButNotReported.length) {
      throw new CliInconsistencyError("cli-fs-disagreement", {
        node: d.node, folder,
        cliReportedButNotOnDisk: cliReportedButNotOnDisk.slice(0, 10), cliOnlyCount: cliReportedButNotOnDisk.length,
        onDiskButNotReported: onDiskButNotReported.slice(0, 10), fsOnlyCount: onDiskButNotReported.length,
      });
    }
  }
}

/**
 * The same idea as `crossCheckFs`, for CONTENT rather than existence.
 *
 * Every loss verdict rests on obsidian-cli's `read`: `lost` means the token was in no note and no
 * conflict copy on any node, as reported by Obsidian. That was a single witness. `crossCheckFs`
 * already refuses to take the CLI's word about which files EXIST — this refuses to take its word
 * about what is IN them, using the second source the harness already had but only pointed at
 * listings.
 *
 * A disagreement is an apparatus fault, not a rep outcome: if the two sources cannot agree on the
 * bytes, neither the loss nor its absence means anything, so it throws and the rep ends -OBSFAIL
 * rather than reporting a verdict built on a reading that is in dispute.
 *
 * Run at the SETTLED verdict only, on the observation the verdict is actually computed from, so a
 * mid-sync difference cannot fire — the same discipline as the listing check.
 */
export async function crossCheckContent(
  drivers: ObsidianDriver[], observations: NodeObservation[], logger?: RunLogger,
): Promise<void> {
  const byNode = new Map(drivers.map((d) => [d.node, d]));
  // Obsidian's `read` hands back the note without its trailing newline; `cat` hands back the file.
  // That difference is formatting, not content, and comparing raw would fire on every note.
  const norm = (s: string): string => s.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  for (const o of observations) {
    const d = byNode.get(o.node);
    if (!d) continue;
    const pairs: { path: string; cli: string | null }[] = [
      { path: `${o.note}.md`, cli: o.canonical },
      ...o.conflicts.map((c) => ({ path: c.file, cli: c.content })),
    ];
    const t0 = Date.now();
    let compared = 0;
    for (const { path, cli } of pairs) {
      const disk = await d.readFileFs(path);
      if (!disk.ok && disk.reason === "unavailable") return; // no vault path on this driver → skip
      // The note reading absent while the file is on disk (or the reverse) is the listing check's
      // business, and it has already run; here that combination only means there is nothing to
      // compare, so it is not re-reported as a content fault.
      if (cli === null || !disk.ok) continue;
      compared++;
      if (norm(disk.content) === norm(cli)) continue;
      throw new CliInconsistencyError("cli-fs-content-disagreement", {
        node: o.node, file: path,
        cliLength: cli.length, fsLength: disk.content.length,
        cli: cli.slice(0, 200), fs: disk.content.slice(0, 200),
      });
    }
    logger?.log({ kind: "cross-check", what: "content", node: o.node, note: o.note, files: compared, ms: Date.now() - t0 });
  }
}

/** Severity witness: which "lost" tokens are still recoverable from server history, who wrote
 *  them, and whether the writer left behind the conflict file it should have.
 *
 *  Model (per Obsidian's own docs): the device holding a locally-differing, not-yet-synced edit is
 *  the one that "detects" the conflict when an incoming remote update supersedes it — it keeps the
 *  remote content as the new canonical note, stashes its OWN prior content into
 *  `(Conflicted copy <device> <ts>)`, and names that file after itself. One device does all three,
 *  which is what makes a conflict file attributable to the device in its title. That is the whole
 *  premise used here.
 *
 *  A stronger claim also holds — the LAST token inside a conflict file is the titled device's —
 *  because every node runs Sync's "create conflict file" mode, so there is no merge step that could
 *  interleave a remote token after this device's own appends (see docs/DESIGN.md). Nothing here
 *  uses it: this function works at the level of FILENAMES only and never reads conflict content.
 *  Note it is a property of that CONFIGURATION, not of Obsidian — under the merge setting it fails.
 *
 *  A lost token can never appear inside ANY conflict file (that would make it "onlyInConflict", not
 *  "lost" — see oracle.ts's checkNote) — so `conflictFileFound` checks whether the writer's device
 *  produced A conflict file for this note at all, not whether it contains this specific token. */
async function lostForensics(driver: ObsidianDriver, verdict: RunVerdict, acked: AckedEdit[]): Promise<LostForensic[]> {
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
    const conflictDevices = new Set(nv.conflictMeta.map((cm) => cm.device));
    for (const token of nv.lost) {
      const versions = contents.map((c, i) => (c.includes(token) ? i : -1)).filter((i) => i >= 0);
      const entry = acked.find((a) => a.note === nv.note && a.token === token);
      assert(entry !== undefined, `lost token ${token} for note ${nv.note} has no matching AckedEdit — oracle.ts's checkNote only ever lists tokens that came from acked in the first place`);
      out.push({
        note: nv.note, token, writer: entry.node,
        inServer: versions.length > 0, serverVersions: versions,
        conflictFileFound: conflictDevices.has(entry.node),
      });
    }
  }
  return out;
}

/** Gate the start of a rep on a known-clean baseline: every node reporting `synced`. Uses the
 *  BOUNDED probe (syncStateProbe), same as waitForSynced's own poll — NOT the retrying
 *  syncStatus(), whose own internal retry-until-recognized loop can itself silently consume up
 *  to ~105s on a single poll attempt (see docs/cli-trust.md). A poll loop that's meant to be
 *  responsive needs each individual sample to actually be quick — an unboundable one defeats the
 *  purpose. No give-up deadline, same reasoning as waitForSynced. Every poll is logged
 *  (`baseline-poll`), same as waitForSynced's `settle-poll` — a stuck node's exact state is
 *  visible in the trace instead of a silent multi-hour gap (found live: a node's own status word
 *  can get stuck for hours, e.g. while its host app is suspended by the OS). */
async function waitNodesSynced(drivers: ObsidianDriver[], probeMs: number, logger: RunLogger): Promise<void> {
  const start = Date.now();
  for (;;) {
    const tProbe = Date.now();
    const states = await Promise.all(drivers.map((d) => syncState(d, probeMs)));
    const probeWallMs = Date.now() - tProbe;
    if (states.every((s) => s === "synced")) {
      const notes = await Promise.all(drivers.map(async (d) => (await d.listFiles()).value?.length ?? 0));
      logger.log({ kind: "baseline-synced", states, notes });
      return;
    }
    logger.log({ kind: "baseline-poll", elapsedSec: Math.round((Date.now() - start) / 1000), states, probeMs: probeWallMs });
    await sleep(1000);
  }
}


/** How far the filesystem may lag its own server version counter before that is worth reporting.
 *
 *  PROVISIONAL, and deliberately crude: an ordinary delivery trails by ~1.4s (measured on a clean
 *  `N1AaN2W`, 2026-09-05), and downloads resolve around 5s in the corpus, so 10s is roughly twice
 *  the normal worst case. It is a noise floor, not a finding — the honest number needs a real
 *  download distribution, which is what the `everything` sampling mode exists to produce. Revisit
 *  it once that has run; do not treat it as measured. */
const FS_TRAIL_NOTABLE_SEC = 10;

/** Consecutive unreadable `sync:history` replies before a wait gives up on counter corroboration.
 *  Three, because the call is bounded and a single blocked read during an active sync is ordinary —
 *  it is a persistent inability to read the counter that matters, not one busy moment. */
const COUNTER_UNREADABLE_GIVE_UP = 3;

/** Per-call cap for the `everything` sampler — NOT `probeSec`.
 *
 *  A sampling round issues its calls together and is only as fast as its slowest one, so the cap is
 *  the round's floor whenever any node cannot answer. With `probeSec` (5s) a single disconnected
 *  node made every round take five seconds — in `everything-no-sleep`, whose entire purpose is
 *  density. The settle's 5s cap is right for the settle, which must not mistake a slow reply for a
 *  stall; it is exactly wrong for a sampler, which would rather record "could not see" and move on.
 *
 *  500ms, matching probe-propagation's own `CALL_CAP_MS`: 4 concurrent execs measured 169ms median
 *  and 189ms p90 against these containers. The cost is that a genuinely slow-but-healthy call is
 *  recorded as blocked — the same ambiguity the probe already accepts, and the lane says `x`
 *  either way. */
const SAMPLE_CAP_MS = 500;

/**
 * `W` — wait until this node genuinely holds what it should, or decide it never will.
 *
 * Two conditions, both on this one node (a user knows what their own client shows, and the harness
 * additionally knows which tokens were introduced elsewhere, which is legitimate because it is the
 * same person sitting at every node):
 *
 *   1. the expected tokens are on its filesystem, and
 *   2. Obsidian here reports `synced`.
 *
 * `synced` alone is not a barrier and never was. It is a LOCAL claim — a node that has lost the
 * network may not have noticed — and measurement says it is optimistic: 324 of 606 sender-side waits
 * in the corpus read `synced` on their first poll, with a hole in the upload histogram at 1s that no
 * real latency distribution would produce. So the claim is corroborated by the server version
 * counter, which is the one signal measured never to move early.
 *
 * NOTHING OUTSTANDING RETURNS AT ONCE. The counter corroborates a pending change; it is not a
 * condition in its own right. With no token missing and the node synced, `W` is done and no counter
 * is read — which is what makes `N1AaWN2WW` terminate instead of waiting on a movement that nothing
 * will ever cause. A redundant `W` is a no-op, but not a silent one: condition 2 is still checked.
 *
 * The two ways this can drag on are different in kind and must not be conflated:
 *
 *   CASE A — the counter has not moved, so the filesystem cannot have either. Nothing is happening;
 *     perhaps the network is down. A bare `W` waits INDEFINITELY here (as every wait in this harness
 *     always has — capSec is not a give-up, it only triggers the host-outage check). `W<n>` gives up
 *     after n seconds and carries on, which is the point of the op: the user who assumes they simply
 *     missed the sync and edits anyway. That is the experiment working, not a failure, and no
 *     verdict attaches — the tokens may land a second later and the rep end clean.
 *
 *   CASE B — the counter HAS moved and the tokens are still not on disk. The server demonstrably
 *     has the data. This is the loss signature the corpus already shows (720 of 733 lost notes end
 *     at total == ackedCount, zero conflict files). Here we stop simulating a user and give Sync
 *     `lossGraceSec` to fix it, still polling. Fixed in time: the near-miss is recorded rather than
 *     swallowed. Not fixed: the history is abandoned and the rep goes straight to its verdict.
 */
async function waitOnNode(
  d: ObsidianDriver,
  note: string,
  expected: string[],
  /** `undefined` = never read (blocked call), so there is no corroboration to be had and `W` falls
   *  back to tokens plus `synced`. `null` = the server genuinely had no history for the note yet, so
   *  any later reading counts as movement. */
  baseline: number | null | undefined,
  /** Does THIS node have a write of its own whose push is still unconfirmed? When it does, the
   *  counter moving is a condition, not merely a diagnosis — it is the only trustworthy evidence the
   *  push left. When it does not, the counter is used solely to tell case A from case B. */
  uploadPending: boolean,
  patienceSec: number | undefined,
  opts: ExecuteOpts,
  logger: RunLogger,
  arrivals?: ArrivalTracker,
  sampleAll?: () => Promise<void>,
  // Optional: fed the same observation, to log it as a `sample`. Set only when `sampleAll` is not,
  // so exactly one of the two writes a node's file lane in any given poll.
  noteObserved?: (o: NodeObservation, ms: number) => void,
): Promise<{ hostOutage: boolean; earlyLoss: boolean; uploadConfirmed: boolean }> {
  const pollMs = opts.sampling === "everything-no-sleep" ? 0 : (opts.pollSec ?? 1) * 1000;
  const probeMs = (opts.probeSec ?? 5) * 1000;
  const capMs = (opts.capSec ?? 120) * 1000;
  const graceMs = (opts.lossGraceSec ?? 60) * 1000;
  let started = Date.now();
  let hostOutage = false;
  let checkedHost = false;
  let movedAt: number | null = null; // when the counter was first seen past its baseline
  let unreadable = 0; // consecutive counter reads that came back as anything but a number
  let uncorroborated = false; // gave up on the counter: it cannot be read at all
  let sawMissing = false; // we observed the tokens genuinely absent at least once
  let missing = expected;

  for (;;) {
    // Every node, not just this one — the point of the `everything` modes. Started at the TOP of
    // the body, so a wait satisfied on its very first pass still samples: with this at the bottom,
    // every short wait returned before sampling anything and the timeline's `vers` lanes simply
    // began wherever the first SLOW wait happened to be.
    //
    // Fired but NOT awaited here: the sampler's reads and this poll's own reads are independent, so
    // a round costs max(sampler, poll) rather than their sum. Awaiting first made every wait's first
    // decision wait out a full sampling round — up to the sampler's cap — before it even probed.
    // Rejections are swallowed: a lost round of diagnostics must never fail a rep.
    const sampling = sampleAll?.().catch(() => {});
    const tProbe = Date.now();
    const state = await syncState(d, probeMs);
    const probeWallMs = Date.now() - tProbe;
    const synced = state === "synced";
    if (synced) {
      // Only read content from a SYNCED node: the read blocks on one that is still syncing, and
      // returns mid-flux content, which has fabricated a divergence before now.
      const tGather = Date.now();
      const o = await gatherObservation(d, note);
      const gatherWallMs = Date.now() - tGather;
      const texts = [o.canonical ?? "", ...o.conflicts.map((c) => c.content)];
      missing = expected.filter((t) => !texts.some((x) => x.includes(t)));
      if (missing.length > 0) sawMissing = true;
      arrivals?.observe([o], logger); // free: the content is already in hand
      noteObserved?.(o, gatherWallMs);
    }
    await sampling; // both halves of the round are done; nothing dangles past this point

    // Read AFTER the content, and on every poll until it moves. After, because "the tokens are here
    // and the counter still has not moved" is only evidence of that ordering if the counter was the
    // later of the two reads. Every poll, because the poll on which the tokens land is exactly the
    // one whose counter reading decides which weirdness (if any) this was.
    if (baseline !== undefined && movedAt === null && !uncorroborated) {
      const r = await d.snapshotVersionsTotal(note, probeMs);
      if (r.status === "ok") {
        unreadable = 0;
        if (baseline === null || (r.total ?? 0) > baseline) movedAt = Date.now();
      } else if (++unreadable >= COUNTER_UNREADABLE_GIVE_UP) {
        // A counter we cannot read is not a counter that has not moved. Waiting on corroboration
        // that will never arrive would hang the whole rep on a CLI fault, so say plainly that this
        // wait is uncorroborated and fall back to tokens plus `synced` — weaker, and logged as such,
        // rather than silently stuck.
        uncorroborated = true;
        logger.log({ kind: "wait-uncorroborated", node: d.node, note, reads: unreadable, lastStatus: r.status });
      }
    }

    // One line per poll, so a wait's time-spend stays visible after the fact — and so the timeline
    // reconstruction has something to draw this node's `sync` lane from. `missing` is null when the
    // node was not synced, because content is deliberately not read from a syncing node: we do not
    // know what is on its disk, which is not the same as knowing it is complete.
    logger.log({
      kind: "settle-poll", elapsedSec: Math.round((Date.now() - started) / 1000),
      states: [state], everySynced: synced, wait: d.node, note,
      missing: synced ? missing.length : null, counterMoved: movedAt !== null, probeMs: probeWallMs,
    });

    if (synced && missing.length === 0 && (!uploadPending || movedAt !== null || uncorroborated)) {
      if (movedAt === null && baseline !== undefined && sawMissing && !uncorroborated) {
        // The tokens reached the disk without this node's counter ever being seen past its
        // baseline. The counter is supposed to be the conservative signal — never early — so the
        // filesystem overtaking it is the interesting direction, not the boring one.
        logger.log({ kind: "weirdness", what: "fs-led-counter", node: d.node, note });
      } else if (movedAt !== null) {
        // Case B resolved itself. Only report a NOTABLE lag: every ordinary delivery trails its
        // counter a little — the counter moves when the server commits, the file lands when this
        // node has pulled it — so logging each one would file a weirdness per rep and bury the
        // section in its own noise. Measured on a clean `N1AaN2W`: 1.4s.
        const bySec = (Date.now() - movedAt) / 1000;
        if (bySec >= FS_TRAIL_NOTABLE_SEC) {
          logger.log({
            kind: "weirdness", what: "fs-trailed-counter", node: d.node, note,
            bySec: Number(bySec.toFixed(3)),
          });
        }
      }
      return { hostOutage, earlyLoss: false, uploadConfirmed: movedAt !== null };
    }

    if (movedAt !== null && missing.length > 0 && Date.now() - movedAt >= graceMs) {
      logger.log({ kind: "loss-detected", node: d.node, note, missing, graceSec: graceMs / 1000 });
      return { hostOutage, earlyLoss: true, uploadConfirmed: true };
    }
    if (patienceSec !== undefined && Date.now() - started >= patienceSec * 1000) {
      logger.log({
        kind: "wait-handoff", node: d.node, note, patience: patienceSec, missing, syncedAtHandoff: synced,
      });
      return { hostOutage, earlyLoss: false, uploadConfirmed: movedAt !== null };
    }
    // Tell a Sync stall apart from the host's own internet being down; an outage restarts the
    // window rather than counting against it.
    if (!checkedHost && Date.now() - started > capMs) {
      checkedHost = true;
      if (await waitForHostReconnect(logger, { node: d.node, note })) { hostOutage = true; started = Date.now(); }
    }
    if (pollMs > 0) await sleep(pollMs);
  }
}


/**
 * A rep cannot have run faster than its own pauses and waits allow.
 *
 * Blunt on purpose, and the only survivor of a larger idea — see floor.ts for why the op-sequence
 * check that used to sit here was removed. It throws rather than tagging an outcome: a rep that
 * finished too fast did not execute what it is named after, so it is not a wrong RESULT, it is not
 * a result at all — and the cause is a defect in this code rather than a state of the world, which
 * makes every later rep equally suspect.
 */
function assertNotFasterThanPossible(
  minSec: number,
  historyMs: number,
  logger: RunLogger,
  str: string,
): void {
  // Compared in milliseconds against the raw span, not the whole-second `totalSec` the trace
  // records: a floor is fractional, and rounding would make a correct short rep look like a
  // violation. SLACK_MS absorbs timer granularity and early-returning sleeps; it is negligible
  // beside any real missing wait.
  const SLACK_MS = 250;
  if (historyMs >= minSec * 1000 - SLACK_MS) return;
  logger.log({ kind: "duration-below-floor", history: str, historyMs, minSec });
  throw new Error(
    `the ops of "${str}" ran in ${(historyMs / 1000).toFixed(2)}s, under the ${minSec}s its own pauses\n` +
    `  and waits require. The ops themselves are timed here, NOT the closing settle, so Sync being\n` +
    `  fast cannot cause this — at least one op did not wait as long as it claims. Suspect the\n` +
    `  pause/settle plumbing, or a clock that moved: ${logger.path}`,
  );
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
    // Every configured driver's own id (e.g. ["n1","n2"], or [...,"HMMBP.local"] with the local
    // instance) — recorded so a rep that never happens to touch every configured node still
    // shows what was actually live during it (a history's own `ops` only shows what it selected,
    // not the full topology it ran against).
    nodes: drivers.map((d) => d.node),
    isolator: opts.isolator, obsidianVersion: opts.obsidianVersion, localObsidianVersion: opts.localObsidianVersion,
    // Which sampling regime ran. The `everything` modes perturb what they measure, so a reader (and
    // `analyze`) must be able to tell those reps apart from strategic ones rather than pooling them.
    sampling: opts.sampling ?? "strategic",
    containerEngine: opts.containerEngine,
    localVaultName: opts.localVaultName,
    lossGraceSec: opts.lossGraceSec ?? 60, finalSettleSec: opts.finalSettleSec ?? 15,
    pollSec: opts.pollSec ?? 1, minFloorSec: opts.minFloorSec ?? 3,
    capSec: opts.capSec ?? 120, probeSec: opts.probeSec ?? 5,
  });

  // Route the driver's cli-unresponsive (wait-for-recovery) events, and the isolator's own
  // internal network-reachability retries, into this rep's trace.
  for (const d of drivers) d.onEvent = (e) => logger.log(e);
  isolator.onEvent = (e) => logger.log(e);

  // `opts.localNode` is purely a construction-time detail (which array slot run.ts put the local
  // driver in — always last) — used ONCE here to get a direct reference, not as the DSL's own
  // addressing scheme (see driverOf below).
  const localDriver = opts.localNode !== undefined ? drivers[opts.localNode - 1] : undefined;

  // N<d> always means the container literally named `n<d>` — never positional, never the local
  // instance, regardless of how many containers are configured or where `l` sits in --nodes (a
  // container driver's `.node` is literally its container name — see exec.ts's ContainerExecutor).
  // "local" is a structurally separate selector, resolved directly via localDriver — it can never
  // collide with a numbered lookup, since the local driver's name is never "n<number>".
  const driverOf = (sel: number | "local"): ObsidianDriver => {
    if (sel === "local") {
      assert(localDriver !== undefined, "'local' selected but no local driver configured — should be unreachable, run.ts validates L requires a configured local instance before this ever runs");
      return localDriver;
    }
    const d = drivers.find((d) => d.node === `n${sel}`);
    assert(d !== undefined, `N${sel} has no matching container — configured: ${drivers.filter((d) => d !== localDriver).map((d) => d.node).join(", ") || "(none)"}`);
    return d;
  };
  // True once any host-connectivity detour actually fired during this rep (settle-loop cap
  // exhaustion, or the local-Sync guard) — a signal that this rep's timings are inflated by a
  // real recovery wait and shouldn't be trusted for latency analysis, even though the rep itself
  // may still finish and judge cleanly.
  let hostOutage = false;
  // Same idea, but for a local-vault mismatch that was waited out rather than aborted on — a
  // distinct condition from hostOutage (a human switched vaults, not a connectivity blip), so
  // tracked separately.
  let vaultDrift = false;
  // Per-call cap for any bounded sync-state probe this rep makes outside the settle loop itself
  // (the upfront local-Sync check below, waitNodesSynced's baseline poll, pause snapshots) — same
  // knob and rationale as the settle's own probe: never block on a not-yet-synced node.
  const probeMs = (opts.probeSec ?? 5) * 1000;
  // Same cadence the waits poll at, so a pause samples at the rate the rest of the rep does.
  const pollMs = opts.sampling === "everything-no-sleep" ? 0 : (opts.pollSec ?? 1) * 1000;

  // Check the local instance's Sync health ONCE per rep, unconditionally — not gated on whether
  // THIS rep's history happens to select "local" as an edit target. It's a live, continuously-
  // syncing participant in every rep's settle regardless (same reasoning as the `nodes` field
  // above), so a wrong active vault (or Sync otherwise off) must be caught right here, rather
  // than silently timing out reps one after another until some future history happens to touch
  // it. Checked BEFORE waitNodesSynced (the generic, non-throwing baseline gate below) so a
  // broken local vault fails fast instead of first burning the whole baseline wait.
  if (localDriver !== undefined) {
    hostOutage = await assertLocalSyncOn(localDriver, opts, logger);
    vaultDrift = await assertLocalVaultUnchanged(localDriver, opts, logger);
  }

  // No `sync on` here: the network isolator (the default fault primitive) never calls `sync
  // off`, so resuming would be an unforced call with nothing to undo. `preflight()` already
  // resumed once at harness startup (the real one-time paused state after `make containers-up`);
  // Sync stays on for the whole session from there.
  // Start from a known-clean baseline: don't begin editing until every node is synced.
  await waitNodesSynced(drivers, probeMs, logger);

  let activeNode: number | "local" = 1;
  let activeNote: string | undefined;
  const offline = new Set<number>(); // node numbers currently network-disconnected
  const touched = new Set<string>(); // concrete note names seen this run
  const noteLetters = new Map<string, string>(); // concrete note name -> its logical DSL letter
  const acked: AckedEdit[] = [];
  let seq = 0;
  // Per (node, note), that node's server version counter as of just BEFORE the most recent write to
  // the note — the reference `W` compares against to decide whether anything has moved.
  //
  // Read on EVERY node, and read BEFORE the write is issued: no arrival is possible in that gap
  // because the change does not exist yet, so whichever node later runs a `W` holds a baseline that
  // is provably pre-change. A `W` on the receiving node has no local write to hang a baseline off,
  // and would otherwise have to read one after the fact and race the very delivery it is waiting for.
  //
  // Refreshed at a node's OWN append, and only there. Not once per rep — the throttle can batch two
  // edits into a single version, so a baseline from two of this node's appends ago could be
  // satisfied by an upload carrying neither of the tokens this `W` cares about. And not at anyone
  // else's append either, which is the correction: a baseline is not "the counter lately", it is
  // "the counter as it stood before the write this node is waiting to see confirmed". Re-reading it
  // when a DIFFERENT node appends can only replace a correct pre-write value with one that may
  // already count the write — and it used to cost ~230ms on the node whose value was already right,
  // sitting squarely between two appends that were supposed to race each other.
  //
  // Reading it costs nothing extra when the node is the one writing: it rides at the head of that
  // node's own write batch (`editAndConfirm`'s `versionsMs`), one `sh -c` ahead of the append, so no
  // interval exists between the two at all. A node that has never held a baseline for the note gets
  // a standalone read, which is the cheap case by construction — it has no history for the note, and
  // `sync:history` answers "not found" in milliseconds even with no network (docs/DESIGN.md).
  //
  // A missing key means "we could not read it" (the call was blocked) — distinct from a recorded
  // `null`, which means the server genuinely had no history for the note yet, so any later reading
  // counts as movement. With no baseline there is no corroboration, and `W` falls back to tokens
  // plus `synced` rather than inventing a comparison.
  const baselines = new Map<string, number | null>();
  const baseKey = (node: NodeId, note: string): string => `${node}\u0000${note}`;
  /** Record one node's baseline and log it as a sample, whether it was read or inferred.
   *  `undefined` means the call never produced an answer, which is the "no baseline" case above. */
  const recordBaseline = (
    node: NodeId,
    note: string,
    r: { status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string } | undefined,
    inferred = false,
    /** What reading it cost. 0 for an inferred one — nothing was called. */
    ms = 0,
  ): void => {
    const key = baseKey(node, note);
    if (r?.status === "ok") baselines.set(key, r.total ?? 0);
    else if (r?.status === "absent") baselines.set(key, null);
    else baselines.delete(key); // unreadable: no baseline, no corroboration
    logger.log({
      kind: "sample", node, note, baseline: true, ms,
      vers: r?.status === "ok" ? (r.total ?? null) : null,
      versStatus: r?.status ?? "unrecognized",
      ...(r?.raw !== undefined ? { versRaw: r.raw } : {}),
      // Marks a value nobody measured: at a note's genesis the answer is known in advance, and
      // spending an exec to confirm it would widen the very gap the history exists to close.
      ...(inferred ? { inferred: true } : {}),
    });
  };
  /** Notes some node has already TRIED to write, by vault name. Attempted, not landed: an
   *  unconfirmed write may still have created the file, and treating the note as untouched
   *  afterwards would let a later `create` make a numbered sibling the oracle never accounted for. */
  const noteEverWritten = new Set<string>();
  // (node, note) pairs where THIS node has written and its push has not yet been corroborated by
  // its counter moving. Only the author's own key is added, which is what keeps the counter
  // condition off a node that merely receives: a pure receiver has no push to confirm, so requiring
  // its counter to move would hang `N1DAaN2W` forever on a token trapped behind a partition.
  const uploadPending = new Set<string>();
  // One `FileLane` per (node, note) — the shared watcher in timeline.ts, so the harness and the
  // propagation probe cannot end up meaning different things by `m` or `c`. It owns the memory of
  // the last look, including the rule that a look which did not answer disturbs nothing.
  const fileLanes = new Map<string, FileLane>();
  const laneFor = (node: NodeId, note: string): FileLane => {
    const key = baseKey(node, note);
    const l = fileLanes.get(key) ?? new FileLane();
    fileLanes.set(key, l);
    return l;
  };
  /** The file-lane half of a `sample` event, from one look at one note on one node. */
  const fileFacts = (
    node: NodeId, note: string, fileStatus: string, content: string, conflicts: string[],
  ): Record<string, unknown> => laneFor(node, note).look({
    fileStatus, content, conflicts,
    tokens: acked.filter((a) => a.note === note).map((a) => a.token),
  }) as unknown as Record<string, unknown>;

  // What the waits and the settle already read, logged as a `sample` so the file lane draws in
  // STRATEGIC runs too. Nothing extra is measured — `gatherObservation` has already run and the
  // content is in hand. Without it `m`/`M`/`c`/`C` only ever appear under the `everything` modes,
  // since those marks are produced from `sample` events alone.
  //
  // Defined below `sampleAll`, and only when that is undefined: in the `everything` modes the
  // sampler already covers every node each poll, and two emitters marking one lane in one slot
  // draws a contradictory pair (the `Mu` case the `token-arrived` handler in timeline.ts describes).
  //
  // In the `everything` modes, one round of bounded reads across every node and every note touched
  // so far, logged as `sample`. Bounded so a blocked call records `timeout` rather than stalling the
  // poll loop that calls it — the same discipline the propagation probe uses. `undefined` in
  // strategic mode, so the call sites cost nothing.
  const sampleAll = (opts.sampling ?? "strategic") === "strategic" ? undefined : async (): Promise<void> => {
    const notes = [...touched];
    if (notes.length === 0) return;
    await Promise.all(drivers.map(async (dd) => {
      // `ms` on every line below: one `sampleNotes` round trip produces all of this node's samples,
      // so they share its cost. What the line says was observed, and what observing it cost.
      const t0 = Date.now();
      const r = await dd.sampleNotes(NOTE_DIR, notes, SAMPLE_CAP_MS);
      const ms = Date.now() - t0;
      for (const note of notes) {
        const v = r.per.get(note);
        if (!r.ok || !v) {
          logger.log({ kind: "sample", node: dd.node, note, versStatus: "timeout", vers: null, fileStatus: "timeout", sync: "timeout", ms });
          continue;
        }
        // The two readings do not agree: the note read as PRESENT, but the folder listing omitted
        // it. Both replies arrived and both parsed — nothing was unreadable — they simply cannot
        // both be right. Recorded as a weirdness rather than thrown, because a sampler must not
        // abort a rep over a display concern, and the lane draws `!` (unexpected, worth a look)
        // rather than `?` (unreadable). The oracle-grade read throws on this same condition.
        if (v.inconsistent) {
          logger.log({ kind: "weirdness", what: "cli-listing-inconsistent", node: dd.node, note });
        }
        logger.log({
          kind: "sample", node: dd.node, note, ms,
          vers: v.vers, versStatus: v.versStatus, sync: r.sync,
          // The bytes behind an `unrecognized`. Saying only that something could not be parsed
          // leaves nobody able to teach the recognizer — by the time the log is read, the call is
          // long gone.
          ...(v.versRaw !== undefined ? { versRaw: v.versRaw } : {}),
          ...(v.fileRaw !== undefined ? { fileRaw: v.fileRaw } : {}),
          ...fileFacts(dd.node, note, v.fileStatus, v.content, v.conflicts),
        });
      }
      // Arrivals, from the reads already in hand. Only positively-answered looks: `timeout` or an
      // unreadable reply means "we could not tell", which is not "not here yet" (see arrivals.ts).
      if (!r.ok) return;
      const seen = notes.flatMap((note) => {
        const v = r.per.get(note);
        if (!v || (v.fileStatus !== "present" && v.fileStatus !== "absent")) return [];
        return [{
          node: dd.node, note,
          canonical: v.fileStatus === "present" ? v.content : null,
          conflicts: v.conflicts.map((content, i) => ({ file: `${note} (conflict ${i})`, content })),
        }];
      });
      if (seen.length > 0) arrivals.observe(seen, logger);
    }));
  };
  const noteObserved = sampleAll !== undefined ? undefined : (o: NodeObservation, ms: number): void => {
    logger.log({
      kind: "sample", node: o.node, note: o.note, sync: "synced", ms,
      ...fileFacts(
        o.node, o.note,
        o.canonical === null ? "absent" : "present",
        o.canonical ?? "",
        o.conflicts.map((c) => c.content),
      ),
    });
  };
  let earlyLoss = false; // a `W` saw the counter move while the disk stayed empty past the grace

  // NOTE: scripts/repro-lib.sh reimplements a simplified version of this op interpreter in bash,
  // for `make repro`'s standalone reproduction scripts (see src/repro.ts). If you change how an
  // op behaves here (append's create-vs-append fallback, disconnect/connect, what counts as
  // "synced", the token format), check whether scripts/repro-lib.sh needs the same update.
  const historyStartedAt = Date.now();
  // One per rep. Records only; nothing here can change a verdict or how long a wait runs.
  const arrivals = new ArrivalTracker();
  for (const op of history) {
    switch (op.cmd) {
      case "node":
        activeNode = op.node!;
        break;
      case "local":
        activeNode = "local";
        break;
      case "pause": {
        // Logged at START: a pause has no result to report beyond "I did the thing" (just the
        // requested duration, echoed — no measured outcome), unlike pause-snapshot below, which
        // DOES carry a real result and stays logged at its own finish.
        // The node carries so the timeline can draw the pause on the lane of whoever was holding
        // the cursor. A pause is a user action like any other and belongs in the ops row; without a
        // node it could only be drawn on every lane or none.
        logger.log({ kind: "pausing", seconds: op.seconds, node: driverOf(activeNode).node });
        // A pause is the most informative stretch of a `D...P...C` rep — it is where propagation
        // actually happens — and it used to be the one stretch nothing watched, leaving the lanes
        // blank across it and only `pause-snapshot` at the far end to say what changed. Under the
        // `everything` modes it is now sampled throughout, at the same cadence the waits poll at.
        //
        // The pause must never come out SHORTER than asked: the loop is bounded on wall clock and
        // sleeps out whatever the sampling round did not use, so elapsed >= requested. It can
        // overrun by at most one round, which `assertNotFasterThanPossible` (a floor, not a
        // ceiling) does not mind.
        const pauseMs = (op.seconds ?? DEFAULT_PAUSE_SEC) * 1000;
        if (!sampleAll) await sleep(pauseMs);
        else {
          const until = Date.now() + pauseMs;
          while (Date.now() < until) {
            // Swallowed like the waits do it: a lost round of diagnostics must never fail a rep.
            await sampleAll().catch(() => {});
            const left = until - Date.now();
            if (left > 0) await sleep(Math.min(pollMs, left));
          }
        }
        // Snapshot every node (not just the active one — the whole point is seeing what a
        // DISCONNECTED node's own local state looks like during a D…P…C window, invisible
        // otherwise until the final settle). A snapshot is a LOOK, not a judgment: every call
        // is a single bounded attempt via the driver's snapshot* methods — never the paranoid,
        // retrying read()/files()/listDirFs() the oracle uses. A wedged or unrecognized reply
        // is recorded as-is, never chased, so a snapshot can never itself stall the harness.
        // Entirely opt-out via --skip-snapshot (opts.snapshot === false): none of these CLI
        // calls happen at all, and no `pause-snapshot` event is logged for this P — in case the
        // extra calls are suspected of perturbing timings/results (same caution as
        // the retired would-fail peek's opt-in design, just the opposite default).
        if (opts.snapshot !== false) {
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
          // Time each call individually (debug aid, spotting a slow snapshot call), without
          // affecting their concurrency.
          const mkTimed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
            const t0 = Date.now();
            const value = await fn();
            return { value, ms: Date.now() - t0 };
          };
          const snapObs: NodeObservation[] = [];
          const nodesSnapshot = await Promise.all(
            drivers.map(async (d) => {
              const [syncT, fsT, filesT, notesT] = await Promise.all([
                mkTimed(() => syncState(d, SNAPSHOT_SYNC_PROBE_MS)),
                mkTimed(() => d.snapshotFs(NOTE_DIR, probeMs)),
                mkTimed(() => d.snapshotFiles(NOTE_DIR, probeMs)),
                Promise.all(touchedList.map(async (fullname) => {
                  const { value: r, ms } = await mkTimed(() => d.snapshotRead(fullname, probeMs));
                  // Feed the arrival tracker too: this is the ONLY look at a node that isn't the
                  // active one outside the final settle, so it is where a slow delivery to an idle
                  // node gets its lower bound. `unrecognized`/`timeout` mean we don't KNOW what the
                  // node has — passing those on would fabricate an "absent" and invent a bound.
                  if (r.status === "present" || r.status === "absent") {
                    snapObs.push({ node: d.node, note: fullname, canonical: r.status === "present" ? (r.content ?? "") : null, conflicts: [] });
                  }
                  return [noteLetters.get(fullname) ?? fullname, { ...r, ms }] as const;
                })),
              ]);
              const fsRelevant = (fsT.value.entries ?? []).filter((e) => touchedList.some((f) => isRelevant(e, noteBase(f))));
              const filesRelevant = (filesT.value.entries ?? []).filter((e) => touchedList.some((f) => isRelevant(e, f)));
              // Conflict-file NAMES only (from the one `files` call — cheap, bounded, no
              // per-file follow-up reads); their content is what the settle-time oracle judges.
              const conflicts = filesRelevant.filter(isConflictFile);
              return {
                node: d.node,
                sync: { state: syncT.value, ms: syncT.ms },
                fs: { status: fsT.value.status, entries: fsRelevant, ms: fsT.ms },
                files: { status: filesT.value.status, conflicts, ms: filesT.ms },
                notes: Object.fromEntries(notesT),
              };
            }),
          );
          logger.log({ kind: "pause-snapshot", seconds: op.seconds, nodes: nodesSnapshot });
          arrivals.observe(snapObs, logger);
        }
        break;
      }
      case "disconnect":
        // Defense-in-depth: dsl.ts's assertLocalAlwaysConnected already makes this unreachable
        // via any real history, but never trust a single layer for "never disconnect the local instance".
        assert(activeNode !== "local", "the local node must never be disconnected");
        // Logged at START: no result of its own beyond "I did the thing" — the actual outcome
        // (each reachability attempt, and how long it took) is network-probe's job, at ITS finish.
        logger.log({ kind: "disconnecting", node: driverOf(activeNode).node });
        await isolator.disconnect(driverOf(activeNode).node);
        offline.add(activeNode);
        break;
      case "connect":
        assert(activeNode !== "local", "the local node must never be disconnected");
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
        if (activeNode !== "local" && offline.has(activeNode)) {
          logger.log({ kind: "wait-skip", node: driverOf(activeNode).node, note: activeNote, reason: "offline" });
          break;
        }
        if (activeNode === "local") {
          hostOutage ||= await assertLocalSyncOn(driverOf(activeNode), opts, logger);
          vaultDrift ||= await assertLocalVaultUnchanged(driverOf(activeNode), opts, logger);
        }
        const d = driverOf(activeNode);
        // A token still trapped on a DISCONNECTED node cannot arrive here, so requiring it would
        // make a bare `W` wait forever on something the history itself made impossible —
        // `N1DAaN2W` being the ordinary generated shape that would hang. Excluding it only ever
        // makes `W` less strict, and the final settle still judges the rep on everything.
        const offlineNames = new Set([...offline].map((n) => driverOf(n).node));
        const expected = acked
          .filter((a) => a.note === activeNote && !offlineNames.has(a.node))
          .map((a) => a.token);
        const key = baseKey(d.node, activeNote);
        const w = await waitOnNode(
          d, activeNote, expected, baselines.get(key), uploadPending.has(key), op.seconds, opts, logger,
          arrivals, sampleAll, noteObserved,
        );
        hostOutage ||= w.hostOutage;
        if (w.uploadConfirmed) uploadPending.delete(key);
        if (w.earlyLoss) earlyLoss = true;
        break;
      }
      case "append": {
        if (activeNode === "local") {
          hostOutage ||= await assertLocalSyncOn(driverOf(activeNode), opts, logger);
          vaultDrift ||= await assertLocalVaultUnchanged(driverOf(activeNode), opts, logger);
        }
        const noteLetter = op.note!;
        activeNote = opts.noteName(noteLetter); // logical letter -> concrete vault note (also the W target)
        touched.add(activeNote);
        noteLetters.set(activeNote, noteLetter);
        const d = driverOf(activeNode);
        // GENESIS: nobody has written this note anywhere yet. The vault name carries the rep id
        // (`uniqueRepId`), so no node can hold server history for it and every baseline is provably
        // `null` — the same value a read would return, for the price of an exec per node on the one
        // op where the harness is trying hardest not to be in the way. Recorded and logged like any
        // other baseline, marked `inferred`, which also starts the timeline's `vers` lanes at t=0 —
        // the reason these samples are logged at all.
        const genesis = !noteEverWritten.has(activeNote);
        noteEverWritten.add(activeNote);
        if (genesis) {
          for (const dd of drivers) recordBaseline(dd.node, activeNote, { status: "absent" }, true);
        } else {
          // Only nodes that have never held a baseline for this note. The writing node is excluded
          // because its own read rides in the write batch below; everyone else keeps what they have,
          // for the reason set out at `baselines`. Bounded, and a blocked node simply records
          // nothing.
          const need = drivers.filter((dd) => dd !== d && !baselines.has(baseKey(dd.node, activeNote!)));
          await Promise.all(need.map(async (dd) => {
            const t0 = Date.now();
            const r = await dd.snapshotVersionsTotal(activeNote!, probeMs);
            recordBaseline(dd.node, activeNote!, r, false, Date.now() - t0);
          }));
        }
        const token = formatToken({ node: d.node, seq: ++seq, note: noteLetter });
        // Exit codes are meaningless (the CLI always exits 0) and append-to-missing
        // silently no-ops, so an edit is only acked after its token is read back
        // locally. If it doesn't land, retry a few times (logging each miss as
        // `edit-unconfirmed`) rather than silently dropping it. Each attempt re-reads
        // first: if the token is already present, a prior attempt landed and a flaky
        // read just hid it — stop, so we never double-append (which would trip the
        // duplication oracle). The happy path logs no extra field — just the op.
        const MAX_ATTEMPTS = 3;
        const tWrite = Date.now(); // the write's own cost, reported on whichever line it produces
        let landed = false;
        let created = false;
        const open = opts.openNotes === true;
        // Genesis already knows the answer, so only a non-genesis write asks for one, and only once.
        let baselineWanted = !genesis;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !landed; attempt++) {
          // A RETRY reads first, and only a retry. We are here because the previous attempt could
          // not be confirmed, which means it may still have landed — appending again would
          // duplicate the token and trip the duplication oracle. On the first attempt there is
          // nothing to be idempotent about, and the read would be a round trip spent guessing at
          // something the write itself answers.
          if (attempt > 1) {
            const before = await d.read(activeNote);
            if (before.ok && (before.value ?? "").includes(token)) { landed = true; break; }
          }
          // APPEND FIRST, create only if the note is positively reported missing. Deliberately this
          // order and not the reverse: `create` on a note that already exists does not fail and does
          // not overwrite — it silently makes a numbered sibling (`<note> 1.md`), which would litter
          // the vault with a file the oracle never accounted for. Guessing wrong toward `append`
          // costs one extra round trip and nothing else.
          //
          // The ONE case where the guess is not a guess is a note's genesis: nothing has tried to
          // write it anywhere, so it exists nowhere, so `append` is certain to come back "not found".
          // Going straight to `create` there spends one round trip instead of two, at the moment
          // that decides whether two nodes create the same note independently or one merely appends
          // to what the other already made — which is the difference between the history the string
          // describes and a sequential one. Only on the FIRST attempt: a retry is here precisely
          // because the previous write may have landed unseen, so it goes back to append-first.
          //
          // Editing before propagation is thus a natural create-create; after it, append-contention.
          // Timing decides, no forced sync.
          const straightToCreate = genesis && attempt === 1;
          const versionsMs = baselineWanted ? probeMs : undefined;
          baselineWanted = false;
          const tBatch = Date.now();
          let w = await d.editAndConfirm(activeNote, token, { create: straightToCreate, open, versionsMs });
          // The baseline rode in this batch, so it costs what the batch cost — there is no separate
          // call to attribute to it.
          if (versionsMs !== undefined) recordBaseline(d.node, activeNote, w.versions, false, Date.now() - tBatch);
          if (straightToCreate) created = true;
          if (w.notFound) {
            created = true;
            w = await d.editAndConfirm(activeNote, token, { create: true, open });
          }
          landed = w.ok && w.present && (w.content ?? "").includes(token);
          if (!landed) logger.log({ kind: "edit-unconfirmed", node: d.node, note: noteLetter, token, attempt, fullname: activeNote, ms: Date.now() - tBatch });
        }
        if (landed) {
          // Always `appended` so the log mirrors the history; `created` marks a create-create
          // (conflict genesis). The noisy exploded name trails as `fullname`.
          // `ms` spans every attempt and both round trips of a create, i.e. what putting this
          // token on disk actually cost — which is the number the append-to-append gap is made of.
          logger.log({ kind: "appended", node: d.node, note: noteLetter, token, created, fullname: activeNote, ms: Date.now() - tWrite });
          uploadPending.add(baseKey(d.node, activeNote)); // cleared when this node's counter moves
          arrivals.appended(token, d.node, activeNote, created);
          acked.push({ note: activeNote, node: d.node, token });
        } else {
          logger.log({ kind: "edit-failed", node: d.node, note: noteLetter, token, attempts: MAX_ATTEMPTS, fullname: activeNote, ms: Date.now() - tWrite });
        }
        break;
      }
    }
    // A `W` saw the server hold a version the disk never received, and the grace ran out. Executing
    // the rest of the history would only pile edits onto a note already known to be broken, so stop
    // here and go straight to the settle and the verdict.
    //
    // Note what this deliberately does NOT do: assert the outcome. The oracle still judges the rep
    // on what it observes. If the settle recovers the token after all, the rep is clean and carries
    // a loud `loss-detected` — which is more informative, and more honest, than a verdict the
    // evidence would contradict.
    if (earlyLoss) {
      logger.log({ kind: "history-abandoned", reason: "loss-detected", atSec: (Date.now() - startedAt) / 1000 });
      break;
    }
  }

  // The history's own span: first op to last, deliberately excluding the reconnect and settle
  // below, so the floor it is checked against needs no term for how long Sync takes.
  const historyMs = Date.now() - historyStartedAt;

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
  // The final settle is where most arrivals are caught: it polls EVERY node at ~1/s for at least
  // 16s, which is the only window in a rep long enough to span a ~10s download. A mid-history W
  // lasts ~5s and usually ends before the token it is waiting for could have landed.
  const stab = await waitForSynced(drivers, noteList, opts.finalSettleSec ?? 15, opts, logger, { final: true }, arrivals, sampleAll, noteObserved);
  hostOutage ||= stab.hostOutage;

  // Judge from the settle's window-confirmed observation, NOT a fresh re-read: a single
  // `files folder=…` listing can transiently omit a conflict file, which would fabricate
  // a "loss" for edits that are actually preserved in that file (docs/cli-trust.md's founding
  // incident, same failure mode).
  const observations = stab.observations;
  // Independent FS second-source: at this settled point, what the CLI lists under bughunt/
  // must exactly match what's on disk — or flag an inconsistency (catches phantom/never-written conflict
  // files and listing dropouts alike).
  await crossCheckFs(drivers, NOTE_DIR, logger);
  // ...and the same second source for what is INSIDE those files, on the very observation the
  // verdict is about to be computed from. Without it every `lost` rests on obsidian-cli alone.
  await crossCheckContent(drivers, observations, logger);
  const verdict = checkRun(acked, observations);

  // Surface conflict-file structure: device named in the file (the producing node),
  // whether the name is well-formed, and which nodes hold it. A malformed name is
  // worth eyeballing even though it doesn't gate the token oracle.
  for (const nv of verdict.notes) {
    for (const cm of nv.conflictMeta) {
      logger.log({ kind: "conflict-file", note: nv.note, file: cm.file, device: cm.device, wellFormed: cm.wellFormed, holders: cm.holders });
    }
  }

  const forensics = await lostForensics(drivers[0], verdict, acked);
  for (const f of forensics) {
    logger.log({
      kind: "lost-forensic", note: f.note, token: f.token, writer: f.writer,
      inServer: f.inServer, serverVersions: f.serverVersions, conflictFileFound: f.conflictFileFound,
    });
  }

  // A whole-history cross-check, deliberately redundant with every per-op check above. See floor.ts.
  const minSec = historyDurationExpectedMinSec(history);
  const timings = {
    totalSec: Math.round((Date.now() - startedAt) / 1000),
    convergenceSec: stab.seconds,
    minSec, // the shortest this history could honestly take — see trace.ts's historyDurationExpectedMinSec
    unsynced: stab.unsynced,
    hostOutage,
    vaultDrift,
  };
  logger.log({ kind: "timings", ...timings });
  assertNotFasterThanPossible(minSec, historyMs, logger, str);
  logger.log({ kind: "results", history: str, timings, acked, observations, verdict, forensics, noteLetters: Object.fromEntries(noteLetters) });
  return { verdict, acked, observations, timings, forensics };
}
