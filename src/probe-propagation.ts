// How fast does a change reach the other node, and where does the time go?
//
// Obsidian Sync throttles uploads to roughly one per 10s PER NOTE: a change goes out at once if that
// note's last upload was at least a window ago, otherwise it waits out the remainder.
//
//     expected delay >= max(0, CYCLE_SEC - secondsSinceThatNotesLastUpload)
//
// A FLOOR, not a prediction. Most writes land on it, but some take longer: the uploader looks to be
// shared, so a write can also queue behind another note's upload already in flight. Measured
// `P2 + edit b` at 5.5s against a ~0s floor, right after note a spent 4.8s uploading.
//
// Per note, not per vault — which is why the history alternates two notes. Editing one note over and
// over cannot tell the two models apart; alternating makes each note's own gap roughly twice the
// pause, and a per-vault model then over-predicts by seconds.
//
// It also explains why creating a note looks "20x faster" than editing one: a creation is just that
// note's first write, with nothing to wait behind. Not a different code path, just never throttled —
// so the model needs no special case for it.
//
// RESOLUTION. Two of the three columns are measured. `total` is write-issued -> readable on the
// peer, at the sampling slot's resolution. `upload` is write-issued -> the moment the SERVER records
// that note's new version, read back from `sync:history` (see below); its resolution is one second,
// because the timestamps carry no finer field. Download is still the subtraction, so it carries both
// errors — and since a truncated upload time is up to a second EARLY, download is biased high by up
// to a second. Anything below NOISE_SEC prints `<1s` rather than a number.
//
// `upload` used to come from the writer's own `sync:status` going `synced`, which is per NODE: with
// two notes outstanding it could not say which write it referred to, so it closed whichever change
// happened to be open. Note `a` in the default history was never dated at all that way, and its
// modelled floor read `~0s` against a real ~9s.
//
// THE SERVER COUNTER, per slot, for both nodes. `sync:history file=<n> total` is the call that
// returns it. Note `total`: the same command WITHOUT it lists the versions themselves, each with a
// timestamp, and those are a different instrument entirely — see THE UPLOAD CLOCK below. Watched here rather than sampled once, because the question it answers is a timing
// one: does either node's counter move ahead of the file arriving? Measured, no — n1's counter,
// n2's counter and the token hitting n2's disk all land in the SAME 0.5s slot, every row. n1's own
// count does not reflect n1's own edit until the peer has it, so the counter tracks delivery rather
// than upload, and cannot be used as a "my push is out" signal.
//
// THE UPLOAD CLOCK, per note. `sync:history file=<n>` (no `total`) lists every version as
// "<ver>: <YYYY-MM-DD HH:MM:SS> (<n> bytes) [<device>]", and that timestamp dates the version's
// UPLOAD. Measured 2026-09-18: writes placed 1s, 5s and 9s into a note's window were all dated at
// the window's EXPIRY (+1.0/+0.0/+0.0s from it, 10.0/5.0/0.9s after their own edit), and a write
// past the window was dated at the edit itself. Re-check with `npm run probe-sync-versions --
// --check`, which asserts it.
//
// So each note's throttle window is dated from the server's own record rather than from a proxy.
// The listing is byte-identical read from either node, is per note, and names its producing device —
// none of which the per-node `sync:status` can do. Two caveats: it is UTC inside the container while
// the host may not be (parsed explicitly as UTC in cli-parse.ts), and the ENTRY only becomes visible
// once a peer has the data, so this reads the past accurately rather than reporting the present
// promptly. Hence one read per arrival, not one per slot: asking earlier cannot answer sooner.
//
// Two hypotheses tested and rejected, kept as flags for re-testing after an upgrade:
//   --poke  polls sync:status on the RECEIVER while waiting, in case asking prompts a pull. It does
//           not — so the harness's own `W` is not accelerating what it waits for.
//   --open  foregrounds the note on the receiver, in case an open note syncs promptly. It does not.
//
// Usage: make probe-propagation [REPEAT=2]        <- prefer this; make passes arguments properly
//        npm run probe-propagation -- --repeat 2  <- note the `--`, or npm eats the flag
//        make probe-propagation HISTORY=N1AaP3AaP3Aa     (probe a different pattern)
//        Needs the nodes up. Creates two notes under bughunt/ per run, like any rep.

import { parseArgs } from "node:util";
import { ContainerExecutor } from "./exec.js";
import { assertNodesReady, ObsidianDriver } from "./driver.js";
import { NOTE_DIR } from "./types.js";
import { parse, type History } from "./dsl.js";
import { NetworkIsolator } from "./isolate.js";
import {
  CounterLane, FileLane, Live, MARK, fileMark, readReading, renderLanes, RULER_STEP_SEC, slot, syncMark,
  fileLane, opsLane, syncLane, versLane, type LaneId, type Slot,
} from "./timeline.js";

const { values } = parseArgs({
  options: {
    nodes: { type: "string" }, bin: { type: "string" },
    repeat: { type: "string" }, history: { type: "string" }, "no-sleep": { type: "boolean" },
    network: { type: "string" },
    poke: { type: "boolean" }, open: { type: "boolean" },
  },
});
const names = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim()).filter(Boolean);
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
if (names.length < 2) {
  console.error("probe-propagation: needs two nodes, e.g. --nodes n1,n2");
  process.exit(2);
}
const [n1, n2] = names.map((n) => new ObsidianDriver(new ContainerExecutor(n, bin)));
// The harness's own isolator, not a hand-rolled `network disconnect`: a D/C here must be the same
// fault a rep applies, including the pinned-IP re-attach and the reconnect budget, or the probe
// measures something the histories do not.
const isolator = new NetworkIsolator(values.network ?? "obsidian-net");
isolator.onEvent = () => {}; // its per-probe events would drown the timelines

/** The upload throttle window, in seconds. Measured 2026-09-02, Obsidian 1.13.7, two Linux
 *  containers. The only stored number — every expectation below derives from it, so if Sync's
 *  behaviour moves, they all miss together and the run says so. No baseline file to maintain. */
const CYCLE_SEC = 10;

/** One sampling slot: how often every signal is read. Measured, a slot's four concurrent calls cost
 *  169ms median / 189ms p90 against these containers, so 300ms leaves headroom and gives ~3 samples
 *  per second.
 *
 *  `--no-sleep` drops the pacing and samples back to back. Measured, that buys less than it sounds:
 *  ~4-5 slots per second against ~3.3 paced, because a slot's own calls cost ~200-250ms through the
 *  driver and that is the real floor — the 300ms pacing only ever idles for the remaining ~50-100ms.
 *  So the knob trades ~35% more samples for ~35% more load on the containers being measured. Paced
 *  stays the default because a fixed slot makes every dot the same duration; the second-boundary
 *  bars keep either mode readable. Nothing here touches the `P` pauses — those are the experiment,
 *  not the sampling. */
const SLOT_MS = 300;

/** Per-call kill. Deliberately LARGER than a slot. A healthy call is ~170ms but occasionally runs to
 *  ~470ms, and capping at the slot length would kill those and record them as `x` — inventing
 *  evidence of blocking, which is the one thing in these timelines worth trusting. The cost is that
 *  a genuinely blocked call overruns its slot; the second-boundary bars show exactly that, as fewer
 *  dots in that second. */
const CALL_CAP_MS = 500;
/** Cap for reading the server's version record, which happens ONCE PER NOTE AFTER THE RUN.
 *  Generous, and it can afford to be precisely because the run is over: `sync:history` blocks until
 *  the queried node is caught up, and Obsidian serialises its IPC, so a call this long anywhere
 *  inside the run holds the channel and starves everything else. That was tried — see the note at
 *  the arrival site — and it stalled the sampler for fifteen seconds. */
const SERVER_READ_CAP_MS = 5_000;

/** How far under the modelled floor a write must go up before it counts against the model.
 *
 *  It has to absorb the upload clock's resolution. The server's timestamps carry no sub-second
 *  field and truncate DOWN, so `up` reads up to a second early and `exp-up` up to a second POSITIVE
 *  — the alarm-raising direction. Measured across today's runs, `exp-up` on healthy rows spans
 *  +0.0s to +1.3s, so 2s clears the worst of it with about 0.7s to spare. It cannot shrink without
 *  a finer clock than the CLI exposes. */
const UNDERSHOOT_MARGIN_SEC = 2;

/** A change slower than this is not latency, it is breakage — and that IS a hard failure. */
const GIVE_UP_MS = 60_000;
/** The upload probe caps at 1s, and n1 keeps reporting "pending" briefly after the data has already
 *  reached n2 — so upload is an OVER-estimate by up to about this much, and download, computed as
 *  total - upload, is under-estimated by the same amount. Under this, neither is a measurement. */
const NOISE_SEC = 1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The default sequence, as a DSL history. Two notes alternating, with the pause stepped so each
 * note's own window is seen full, part-drained, and past its end — and so a write to one note lands
 * while the other is mid-window, which is what shows the throttle is scoped to the note.
 *
 * Override with --history to probe a different pattern; it is parsed by the project's own
 * `parse()`, so a string that works here works in `make run` too.
 */
const DEFAULT_HISTORY = "N1AaP2AbP2AaP2AbP5AaP2AbP8AaP0AbP13AaP0Ab";

type Step =
  | { kind: "write"; pause: number; note: string; node: string }
  | { kind: "fault"; pause: number; op: "disconnect" | "connect"; node: string }
  | { kind: "wait"; pause: number; node: string; patience: number | undefined };

/**
 * DSL string -> the steps this probe can execute.
 *
 * Either node may write, and `W` is understood, so a probe history is an ordinary history: the same
 * string can be handed to `make run` and to the probe, and the two pictures compared. The probe's
 * `W` blocks until every token it is still waiting for is readable on the other node — the same
 * condition the harness's `W` uses, reached from the probe's own bookkeeping rather than from the
 * oracle. `L` is the one op still refused: the probe owns the network, and the local instance must
 * never be partitioned.
 */
function toSteps(history: History, str: string): Step[] {
  const steps: Step[] = [];
  let pending = 0;
  let active = 1;
  for (const op of history) {
    switch (op.cmd) {
      case "node":
        active = op.node!;
        break;
      case "pause":
        pending += op.seconds ?? 0;
        break;
      case "append":
        steps.push({ kind: "write", pause: pending, note: op.note!, node: names[active - 1] });
        pending = 0;
        break;
      case "wait":
        steps.push({ kind: "wait", pause: pending, node: names[active - 1], patience: op.seconds });
        pending = 0;
        break;
      case "disconnect":
      case "connect":
        steps.push({ kind: "fault", pause: pending, op: op.cmd, node: names[active - 1] });
        pending = 0;
        break;
      default:
        throw new Error(`${str}: probe histories accept N1/N2, appends, pauses, W and D/C — found "${op.cmd}"`);
    }
  }
  if (!steps.some((st) => st.kind === "write")) throw new Error(`${str}: no appends, so there is nothing to measure`);
  return steps;
}

/** The history as it will run. Built from the parsed steps rather than echoed from the input, so
 *  what is printed is what will actually execute — including a P0, which is part of the experiment. */
const historyOf = (steps: Step[]): string => {
  let out = "";
  let active = "";
  for (const st of steps) {
    if (st.node !== active) { out += `N${names.indexOf(st.node) + 1}`; active = st.node; }
    if (st.pause > 0) out += `P${st.pause}`; // P0 and "no pause" are the same op; print neither
    out += st.kind === "write" ? `A${st.note}`
      : st.kind === "wait" ? `W${st.patience ?? ""}`
      : st.op === "disconnect" ? "D" : "C";
  }
  return out;
};

interface Change {
  op: string;          // "P4 + edit a"
  note: string;
  /** Who wrote it, and who is therefore watched for its arrival. With both nodes able to write,
   *  "the observer" is per-change rather than a property of the probe. */
  writer: string;
  observer: string;
  /** The text this write appends, and the thing watched for on n2. Assigned when the table is
   *  planned, so matching an arrival never has to work out which row a change was. */
  token: string;
  /** Was any node cut off when this write was issued? Recorded then, because the retrospective pass
   *  cannot see a partition that has since healed, and under a cut the throttle does not govern. */
  partitioned: boolean;
  /** Seconds from this note's previous UPLOAD BY THIS WRITER to this write — what the throttle acts
   *  on. Taken from the server's own version record, after the run, never from an arrival (which
   *  dates delivery) or from `sync:status` (which is per node and cannot say which write a `synced`
   *  refers to). `Infinity`, printed `—`, for a note's first write: nothing of it existed to go up.
   *  The value held during the run is provisional — see the retrospective pass. */
  sinceSynced: number;
  created: boolean;
  expected: number;
  issuedMs: number;
  /** When the write COMMAND returned. Until then n1 has nothing pending and `sync:status` reads
   *  `synced` for the trivial reason that the write has not happened yet — timing the upload from
   *  before this point records ~0s for a push never issued. */
  writtenMs: number | null;
  /** Why the write call itself did not succeed, or null if it did. A THIRD state alongside
   *  "never attempted" (`issuedMs === 0`) and "attempted and landed": attempted, and the CLI
   *  refused or was killed. The distinction matters for the same reason `unissued` exists — a
   *  write that never reached disk is not evidence about propagation, and reporting it as a
   *  change that "never arrived at the peer" accuses Sync of losing something that was never
   *  written. Kept as the message, not a bare flag, because the failure is the only record: the
   *  raw primitives used below (`appendLine`/`createNote`) do NOT read back what they wrote, so
   *  unlike the run path's `editAndConfirm` there is no second chance to notice. */
  writeError: string | null;
  uploadSec: number | null;
  arriveSec: number | null;
}

/**
 * ONE loop for the whole history.
 *
 * The earlier design ran a fresh sampler per write and waited for it to arrive before advancing, so
 * nothing was observed during a `P`, and a write whose delivery depended on a LATER `C` deadlocked:
 * `N1AaN2DN1P2AaN2C` sat for 60s on the second write because the reconnect that would deliver it was
 * the step it refused to reach. Here the loop owns the schedule instead: it issues each step when
 * due and keeps sampling regardless, so a token can land whenever it lands — during a pause, or ten
 * steps later after a reconnect.
 *
 * Pauses therefore mean what they mean in the DSL — time between OPS — rather than time after a
 * delivery. `note idle` shifts accordingly, and is the smaller figure it always should have been.
 */
async function runAll(steps: Step[]): Promise<{ changes: Change[]; render: string[] }> {
  const stamp = Date.now().toString(36);
  const noteOf = (letter: string) => `${NOTE_DIR}/prop-${stamp}-${letter}`;
  const letters = [...new Set(steps.flatMap((st) => (st.kind === "write" ? [st.note] : [])))].sort();

  // The lanes, in the order they are drawn. n1 writes and n2 observes for now, so only n2 gets a
  // `file` lane — §7 of the plan symmetrises this once both nodes can write.
  const lanes: LaneId[] = names.flatMap((n) => [
    opsLane(n), syncLane(n),
    ...letters.flatMap((l) => [versLane(l, n), fileLane(l, n)]),
  ]);
  const counters = new Map<LaneId, CounterLane>(
    letters.flatMap((l) => names.map((n) => versLane(l, n))).map((id) => [id, new CounterLane()]),
  );
  const slots: Slot[] = [];
  const live = new Live();
  // The drivers' own events — a retried call, an unreadable reply — otherwise go to the emit()
  // fallback, which writes straight to the terminal. Straight INTO the frame, that is: the block is
  // redrawn in place, so a raw line lands in rows the renderer owns and every rewind after it walks
  // up through the wrong rows. The display comes apart precisely when something is wrong enough to
  // be emitting. Routed above the frame instead, where they scroll like ordinary output.
  //
  // Not silenced, unlike the isolator's below: these say why a probe answered the way it did, which
  // is the thing you came to read when a run looks odd.
  for (const d of [n1, n2]) d.onEvent = (e) => live.log(`· ${JSON.stringify(e)}`);
  const byName = new Map(names.map((n, i) => [n, [n1, n2][i]]));
  // Set while a `W` holds the schedule. The sampler keeps running underneath — that is the whole
  // point of one continuous loop — so a `W` here costs observations nothing.
  let blocked: { node: string; patience: number | undefined; since: number } | null = null;
  const fileLanes = new Map<string, FileLane>(); // (node, letter) -> its watcher, which owns the memory

  // Every row of the table is known before a single step runs: which steps write, in what order, to
  // which note, after what pause, and whether that write is the note's first. Only the NUMBERS are
  // unknown. So the table is planned here in full and printed complete from the first frame, and
  // fills in left to right — rather than growing downwards a row at a time while the run happens,
  // which made the block jump under the reader on every write.
  const planned = new Set<string>();
  const changes: Change[] = steps.flatMap((st, i) => {
    if (st.kind !== "write") return []; // faults move the dot rows, not the table
    const created = !planned.has(st.note);
    planned.add(st.note);
    // Keyed by the STEP index, not a row counter: unique either way, and it survives a history
    // being edited without silently renumbering the tokens of the writes around it.
    return [{
      op: `${st.pause > 0 ? `P${st.pause} + ` : ""}${created ? "create" : "edit"} ${st.note} @${st.node}`,
      note: st.note, created, token: `(prop-${i})`,
      writer: st.node, observer: names.find((n) => n !== st.node) ?? st.node,
      // Placeholders that render as `—` until the step is actually issued: an un-issued row is
      // indistinguishable from one whose measurement is genuinely unavailable, which is correct —
      // neither has a number to show.
      sinceSynced: Infinity, expected: NaN,
      issuedMs: 0, writtenMs: null, writeError: null, uploadSec: null, arriveSec: null, partitioned: false,
    }];
  });
  let writeIdx = 0; // which planned row the next write step fills in
  /** Every upload time the server has reported for a note, by the node that wrote it. Accumulated
   *  rather than reduced to "the newest": the retrospective pass needs the whole grid, and one read
   *  that came back short must not lose what an earlier one already established. */
  // Keyed by the DSL LETTER, which is what a `Change` carries in `note` — not by the full
   // `bughunt/prop-<stamp>-a`. Keying it by the full name once left every lookup empty and every row
   // reading `—`, which is a silent failure rather than a loud one.
  const grid = new Map<string, Map<string, number>>(); // letter -> "<device>@<epoch>" -> epoch
  const addRows = (letter: string, rows: { uploadedAt: number; device: string }[]): void => {
    const g = grid.get(letter) ?? new Map<string, number>();
    for (const r of rows) g.set(`${r.device}@${r.uploadedAt}`, r.uploadedAt);
    grid.set(letter, g);
  };
  /** A note's upload times BY ONE DEVICE, oldest first. Kept per device because the throttle acts on
   *  the writer's own uploader; whether two nodes writing one note share a window is not established,
   *  and pooling them would quietly assume they do. */
  /** Re-derive every row's floor, wait and split from the upload grid as it stands.
   *
   *  Called every slot AND once more after the run. The grid grows monotonically, so a later call
   *  can only sharpen a row — and running it live is what lets the table fill as the run goes
   *  instead of appearing all at once at the end. Cheap: arithmetic over a handful of timestamps,
   *  no calls.
   *
   *  It must be idempotent, because it recomputes rows it has already computed. Everything here is a
   *  pure function of (grid, issuedMs, partitioned), which is why it can be. */
  const derive = (): void => {
    const everWritten = new Set<string>(); // notes seen so far, oldest write first
    for (const c of changes) {
      if (c.issuedMs === 0) continue; // never ran: the budget expired before the history did
      const first = !everWritten.has(c.note);
      everWritten.add(c.note);
      const times = gridFor(c.note, c.writer);
      // The note's own last upload STRICTLY BEFORE this write. Two writes coalesced into one upload
      // share it, which is why their `exp-up` comes out identical — the issue time cancels.
      //
      // None, by construction, for a note's FIRST write: nothing of that note can have gone up before
      // it existed. Not a formality — the timestamps truncate DOWN, so a create's own upload is
      // routinely dated before the create, and taken as a predecessor it made the note look mid-window
      // (`expect ~10s` against a 1.1s delivery), which is undershoot, which raised a false alarm
      // against the floor.
      const prev = first ? undefined : times.filter((t) => t < c.issuedMs).pop();
      c.sinceSynced = prev === undefined ? Infinity : (c.issuedMs - prev) / 1000;
      c.expected = c.partitioned ? NaN
        : prev !== undefined ? Math.max(0, CYCLE_SEC - c.sinceSynced)
        // No upload precedes the note's FIRST write, and there is nothing to queue behind: a genuine
        // 0. For any later write it means the grid is missing an upload, which is not a floor of zero,
        // it is no floor at all.
        : first ? 0
        : NaN;
      // The upload that carried this write: the note's first upload after it. A second of slack,
      // because the timestamps truncate DOWN — an upload a fraction after a write can be dated a
      // fraction before it, and the run's first upload can even be dated before `started`.
      //
      // But the slack must never reach back past `prev`. It did, and that is its own bug: for a write
      // issued 0.7s after an upload, `>= issued - 1s` selected THAT upload as the carrier, giving
      // up <1s against a real 9.3s wait — and a `down` of 10.4s, a download supposedly longer than the
      // whole propagation. Whatever preceded the write cannot also have carried it.
      const carried = times.find((t) => t >= c.issuedMs - 1000 && (prev === undefined || t > prev));
      if (carried !== undefined) c.uploadSec = Math.max(0, (carried - c.issuedMs) / 1000);
    }
  };

  const gridFor = (letter: string, device: string): number[] =>
    [...(grid.get(letter) ?? new Map<string, number>())].filter(([k]) => k.startsWith(`${device}@`))
      .map(([, at]) => at).sort((a, b) => a - b);
  const offline = new Set<string>();
  const pending: Change[] = []; // written, not yet seen on n2

  live.draw(frame(changes, slots, lanes)); // the skeleton, before anything has been measured

  let stepIdx = 0;
  let nextStepAt = Date.now();
  const started = Date.now();

  for (;;) {
    const slotStart = Date.now();

    // --- 1. is a step due? ----------------------------------------------------------------------
    const opsChar = new Map<string, string>();
    if (blocked === null && stepIdx < steps.length && Date.now() >= nextStepAt) {
      const st = steps[stepIdx++];
      if (st.kind === "fault") {
        if (st.op === "disconnect") { await isolator.disconnect(st.node); offline.add(st.node); }
        else { await isolator.connect(st.node); offline.delete(st.node); }
        opsChar.set(st.node, st.op === "disconnect" ? "D" : "C");
      } else if (st.kind === "wait") {
        // The probe's own `W`: hold the schedule until nothing this node is still waiting for is
        // outstanding. It knows the tokens exactly, so this is the harness's token condition
        // reached from bookkeeping rather than from the oracle — and it never sleeps, because the
        // sampler must keep running underneath it.
        blocked = { node: st.node, patience: st.patience, since: Date.now() };
        opsChar.set(st.node, "W");
      } else {
        const full = noteOf(st.note);
        const c = changes[writeIdx++];
        const d = byName.get(c.writer)!;
        // NOTHING about the floor is computed here, and the five server-derived columns stay blank
        // until the run ends.
        //
        // The only per-note upload signal is the server's version record, and it cannot be read
        // during the run without blocking the IPC — tried twice, see the arrival site. So at write
        // time the note's previous upload is genuinely unknown, and every live value for it was
        // either a guess or, worse, a number: a stale anchor reads as "the window has expired",
        // which is the most confident answer there is.
        //
        // What was shown live instead came from three different mechanisms at three different times
        // — one column filling in bursts as tokens arrived, one filling semi-randomly from a
        // per-node reading that closed whichever write happened to be open, three that could not
        // fill at all — and then all of it replaced wholesale at the end. A table that fills in an
        // order nobody can explain invites reading a partial row as a result. Blank says what is
        // true: not known yet.
        //
        // `partitioned` is the exception, because it is the one thing only the present knows: the
        // retrospective pass cannot see a cut that has since healed.
        c.partitioned = offline.size > 0;
        c.issuedMs = Date.now();
        // Fire and forget: awaiting here would stall the sampler, which is the whole point of the
        // rewrite. A rejected write still resolves the guard so the loop cannot wedge on it.
        //
        // Not awaiting is fine; DISCARDING THE REJECTION was not. Both handlers used to be the
        // same `c.writtenMs = Date.now()`, which made a write that threw indistinguishable from
        // one that landed — and since `issuedMs` is stamped above, before the call is even fired,
        // such a row then counted as ISSUED and so as "never arrived at the peer", i.e. as data
        // loss. Recording the error costs nothing and needs no await.
        void (c.created ? d.createNote(full, `${c.token}\n`) : d.appendLine(full, c.token))
          .then(
            () => { c.writtenMs = Date.now(); },
            (e: unknown) => {
              c.writtenMs = Date.now();
              // `CliUnrecognizedOutput`'s message is built from argv + STDOUT only, so an empty
              // reply reads as `: ""` and says nothing about WHICH layer produced it — the engine
              // exec failing to reach the container, or obsidian-cli running and printing nothing,
              // are indistinguishable there. The exit code and stderr are the two fields that tell
              // them apart, and they are already on the carried `raw`; pull them out.
              const raw = (e as { raw?: { code?: number; stderr?: string; killed?: boolean } }).raw;
              const detail = raw
                ? ` [exit=${raw.code ?? "?"} killed=${raw.killed ?? "?"} stderr=${JSON.stringify(raw.stderr ?? "")}]`
                : "";
              c.writeError = (e instanceof Error ? e.message : String(e)) + detail;
            },
          );
        pending.push(c);
        // The note's own letter, so a history touching several notes says WHICH one moved. Note
        // letters are lowercase and the fault marks uppercase, so `d` and `D` never collide.
        opsChar.set(st.node, st.note);
      }
      nextStepAt = Date.now() + (steps[stepIdx]?.pause ?? 0) * 1000;
    }

    // --- 2. sample every touched note on EVERY node, plus each node's push state ----------------
    // One batched exec per node: sync state, each note's server counter, its content, and any
    // conflict copies. The round trip is the whole cost (an empty exec measures the same as a
    // `read`, see docs/DESIGN.md), so this is 2 execs a slot rather than 2 + 4*letters.
    const shots = await Promise.all(names.map((n) =>
      byName.get(n)!.sampleNotes(NOTE_DIR, letters.map(noteOf), CALL_CAP_MS, true)));
    const shotOf = (n: string) => shots[names.indexOf(n)];
    // The push probe stays separate and conditional. "skip", never a fake "synced": the guard is
    // evaluated when this slot's calls are built, and a write can complete DURING the slot —
    // resolving "synced" here let that fake reading close the upload of a push only just issued,
    // recording ~0s for it.
    const syncStates = await Promise.all(names.map((n) =>
      changes.some((c) => c.writer === n && c.arriveSec === null && c.writtenMs !== null)
        ? byName.get(n)!.syncStateProbe(CALL_CAP_MS) : Promise.resolve("skip")));

    // --- 3. record ------------------------------------------------------------------------------
    const now = Date.now();
    // Second bars are derived by the renderer from these timestamps, so a live loop and a
    // reconstruction from a log produce the same grid.
    const cur = slot((now - started) / 1000);
    for (const [node, ch] of opsChar) cur.marks.set(opsLane(node), ch);
    // `skip` is not a reading — the probe declined to ask — so the lane shows nothing rather than
    // claiming an observation. That is the same distinction the reconstruction relies on.
    names.forEach((n, i) => {
      const st = syncStates[i];
      if (st === "skip") return;
      cur.marks.set(syncLane(n), syncMark(st));
    });
    // The rows the sampler just brought back, straight into the grid. Per SLOT, not per arrival:
    // a killed call is then just an `x` and the next slot catches up, where a one-shot read left the
    // record permanently stale. That difference — self-healing versus one chance — is the whole
    // reason this can be live at all.
    for (const n of names) {
      for (const l of letters) {
        const up = shotOf(n).per.get(noteOf(l))?.uploads;
        if (up !== undefined) addRows(l, up);
      }
    }
    derive();

    for (const n of names) {
      const shot = shotOf(n);
      for (const l of letters) {
        const full = noteOf(l);
        const v = shot.per.get(full);
        if (!shot.ok || !v) {
          cur.marks.set(versLane(l, n), MARK.blocked);
          cur.marks.set(fileLane(l, n), MARK.blocked);
          continue;
        }
        cur.marks.set(versLane(l, n), counters.get(versLane(l, n))!.mark(
          readReading({ status: v.versStatus, total: v.vers ?? undefined })));

        // A change is watched on ITS OWN observer — the node that did not write it. With both nodes
        // writing there is no single "the observer" any more, so reading the writer's own copy back
        // and calling it an arrival would report every write as delivered instantly.
        const landed = pending.filter((c) => c.note === l && c.observer === n && v.content.includes(c.token));
        for (const c of landed) {
          c.arriveSec = (now - c.issuedMs) / 1000;
          pending.splice(pending.indexOf(c), 1);
          // NOTHING IS READ HERE. The obvious move is to ask the server when this note's version
          // went up, the moment its token lands — and it was done that way, twice, wrongly:
          //
          //   at the slot cap (500ms) the read was KILLED under load, leaving the note's upload date
          //   a full cycle stale; and a stale date does not read as missing, it reads as "the window
          //   has expired, go now", which produced large negative `exp-up` values.
          //
          //   at a cap generous enough to survive (5s) the read BLOCKS instead. `sync:history` waits
          //   until the queried node is caught up, and Obsidian serialises its IPC, so it holds the
          //   channel for seconds: the sampler starves (a wall of `x` down every lane), and the
          //   writes queued behind it are delayed, inflating the very numbers being measured.
          //
          // Both failures are the same mistake — putting a blocking call on the path of a live
          // experiment. The grid is read ONCE, after the run, where nothing is waiting on the
          // channel and a slow answer costs nothing. See the retrospective pass below.
        }

        // The same watcher the harness uses (timeline.ts), so `m`/`c` cannot come to mean
        // different things in the two pictures — and so the non-answer rule is fixed in one place.
        const key = `${n}\u0000${l}`;
        const lane = fileLanes.get(key) ?? new FileLane();
        fileLanes.set(key, lane);
        const facts = lane.look({
          fileStatus: v.fileStatus, content: v.content, conflicts: v.conflicts,
          tokens: changes.filter((c) => c.note === l && c.issuedMs !== 0).map((c) => c.token),
        });
        cur.marks.set(fileLane(l, n), fileMark({ ...facts, lost: facts.lost === true }));
      }
    }
    // Release a `W` once nothing this node is still waiting for is outstanding, or its patience is
    // spent. Checked AFTER this slot's arrivals, so a token landing in the same slot releases it
    // here rather than costing a whole extra poll.
    if (blocked !== null) {
      const stillWaiting = pending.some((c) => c.observer === blocked!.node);
      const spent = blocked.patience !== undefined && now - blocked.since >= blocked.patience * 1000;
      if (!stillWaiting || spent) {
        blocked = null;
        nextStepAt = Date.now() + (steps[stepIdx]?.pause ?? 0) * 1000;
      }
    }
    slots.push(cur);
    // n1 reporting nothing outstanding closes every write still waiting on its push. With overlapping
    // writes they share the timestamp — `sync:status` is per node, not per write, and inventing a
    // per-write attribution it cannot support would be worse than saying the same thing twice.
    // --- 4. show, then done? --------------------------------------------------------------------
    live.draw(frame(changes, slots, lanes));
    if (stepIdx >= steps.length && pending.length === 0) break;
    if (Date.now() - started > GIVE_UP_MS) break;
    if (!values["no-sleep"]) {
      const rest = SLOT_MS - (Date.now() - slotStart);
      if (rest > 0) await sleep(rest);
    }
  }

  // --- retrospective pass: every row re-derived from the complete upload grid -------------------
  //
  // WHY NOT AT WRITE TIME. A note's previous upload is a fact about the past, but the probe only
  // learns of an upload when its token ARRIVES — up to a download later. A write issued in that gap
  // therefore computed its floor from an anchor one upload stale, and a stale anchor does not read
  // as missing: `max(0, 10 - 10.5)` reads as "the window has expired, go now", the most confident
  // answer available. That is where the large negative `exp-up` values came from. Measured: note a
  // uploaded at -0.3s, 9.7s and 19.7s, while a write at 11.4s was still anchored to 0.9s.
  //
  // Asking at write time instead would mean a blocking read in front of the write — the one thing
  // this probe must not do, since it would delay the write it is timing.
  //
  // So: one read per note at the end, unioned with everything seen during the run, and every row
  // re-derived from it. With the anchors right, each row's `expect` and `up` agreed to 0.0s.
  for (const l of letters) {
    const note = noteOf(l);
    // Whichever node answers. The listing is the SERVER's record — measured byte-identical from
    // either node — so one good read is the whole grid, versions from both devices included. Nodes
    // are tried in turn because a history can leave one partitioned right up to here (the network is
    // restored on the way out of main, after this).
    for (const n of names) {
      const h = await byName.get(n)!.snapshotSyncHistory(note, SERVER_READ_CAP_MS);
      if (h.status !== "ok") continue;
      addRows(l, h.versions ?? []);
      break;
    }
  }
  derive();
  live.rewind();
  return { changes, render: frame(changes, slots, lanes) };
}

/** The whole visible state of a run: the table as it currently stands, then the dot rows. Drawn
 *  every slot while the run happens, and once more when it ends. */
function frame(changes: Change[], slots: Slot[], lanes: LaneId[]): string[] {
  return [
    ...TABLE_HEAD,
    ...changes.map(row),
    "",
    // One element per LINE: Live counts rows to rewind by, and an element carrying its own newline
    // used to be counted as one.
    `    each char ~${SLOT_MS}ms   | second boundary, numbered every ${RULER_STEP_SEC}s on the seconds lane`
    + `   a/b/... note written   D/C disconnect/connect   W wait`,
    `    x call blocked   - not there yet   . nothing to report   (blank) not sampled`,
    `    digit new version count   . u m M  file: complete / complete+changed / missing / missing+changed`,
    "",
    ...renderLanes(slots, lanes),
  ];
}

/** Below the noise floor there is no number to report, so say so instead of printing a spurious one
 *  (or a negative). Above it, one decimal is all the sampling justifies. */
const f = (x: number | null, w: number): string =>
  (x === null ? "—" : x < NOISE_SEC ? `<${NOISE_SEC}s` : `${x.toFixed(1)}s`).padStart(w);

/** The expectation is a model output, not a measurement: whole seconds, marked approximate. */
const fexp = (x: number, w: number): string => (Number.isNaN(x) ? "—" : `~${Math.round(x)}s`).padStart(w);

/** Seconds since this note's own upload was last confirmed. `—` when there is no such moment on
 *  record: the note has never been written, or no write to it has ever had its upload timed. */
const fsynced = (x: number, w: number): string => (Number.isFinite(x) ? `${x.toFixed(1)}s` : "—").padStart(w);

/** `expected - up`: how far the modelled floor missed. POSITIVE means the write went up SOONER than
 *  the note's own window allows, which is the one direction that falsifies the model and the one the
 *  verdict acts on. Negative is overshoot — normal, the uploader is shared. */
const fmiss = (expected: number, up: number | null, w: number): string =>
  (!Number.isFinite(expected) || up === null ? "—" : `${expected - up >= 0 ? "+" : ""}${(expected - up).toFixed(1)}s`).padStart(w);

// Short names; COLUMN_KEY below says what each one means in full. The names have to stay short
// because the six full ones come to ~170 characters, and this block is redrawn in place — every row
// it gains is a row nearer to not fitting the terminal at all.
const COLS = `    ${"operation".padEnd(20)} ${"last up".padStart(8)}  ${"expect".padStart(7)}  ${"up".padStart(6)}  ${"down".padStart(6)}  ${"total".padStart(7)}  ${"exp-up".padStart(7)}`;
const TABLE_HEAD = [COLS, `    ${"-".repeat(COLS.length - 4)}`];

/** Printed ONCE, before the live block, not inside it: it never changes, and inside it would cost
 *  seven rows of the height the redraw has to fit. */
export const COLUMN_KEY = [
  "    last up   time since this note was last synced UP, per the server's own version record",
  "    expect    expected next sync up = 10s (the per-note throttle) since last up; ~0s once past it",
  "    up        synced up after: write issued -> the server records the version. 1s resolution",
  "    down      synced down after = total - up. NOT measured directly (no receiver-side signal",
  "              dates receipt), and up is truncated DOWN to the second, so this reads up to 1s high",
  "    total     total propagation time: write issued -> readable on the other node",
  "    exp-up    expect - up. Positive = it went up sooner than the throttle allows, which is the",
  "              only direction that falsifies the model; negative is overshoot, which is normal",
];

function row(c: Change): string {
  // n1 can go on reporting "pending" after n2 can already read the change; the row cannot then be
  // decomposed, so both split columns go blank rather than printing a negative dressed up as "<1s".
  const undecomposable = c.arriveSec !== null && c.uploadSec !== null && c.uploadSec > c.arriveSec + NOISE_SEC;
  const up = undecomposable ? null : c.uploadSec;
  const down = c.arriveSec === null || c.uploadSec === null || undecomposable ? null : c.arriveSec - c.uploadSec;
  return `    ${c.op.padEnd(20)} ${fsynced(c.sinceSynced, 8)}  ${fexp(c.expected, 7)}  ${f(up, 6)}  ${f(down, 6)}  ${f(c.arriveSec, 7)}  ${fmiss(c.expected, up, 7)}`;
}

async function main(): Promise<void> {
  const repeat = Number(values.repeat ?? 1);
  const str = values.history ?? DEFAULT_HISTORY;
  // Round-trip through the parser so the header prints what will actually run, not what was typed.
  const steps = toSteps(parse(str), str);
  // Checked after parsing (a bad history should fail without touching a node) and before the first
  // write. Against an absent node the whole history runs against nothing; against a paused one every
  // change simply never arrives, and the run spends GIVE_UP_MS per change to report a data loss that
  // is only a node nobody started.
  await assertNodesReady([n1, n2]);
  let bad = 0;
  let lost = 0;
  let unissued = 0;
  let unwritten = 0;
  const writeErrors: string[] = [];
  for (let r = 1; r <= repeat; r++) {
    console.log(`\n  ${historyOf(steps)}${repeat > 1 ? `   (run ${r}/${repeat})` : ""}\n`);
    if (r === 1) { for (const line of COLUMN_KEY) console.log(line); console.log(""); }
    // Drawn live on a TTY and returned either way, so a redirected run still gets the block. No row
    // is final until the end — with one continuous sampler an arrival can land long after later
    // steps were issued — which is exactly why the live view redraws rather than appends.
    const { changes, render } = await runAll(steps);
    for (const line of render) console.log(line);
    // Only ISSUED writes can be lost. Now that the table is planned up front, a run that hits
    // GIVE_UP_MS mid-history leaves later rows never attempted — counting those as "never arrived"
    // would report a write that was never made as a data loss.
    // …and by the same argument one step further: a write that WAS attempted but whose call
    // failed never reached disk either, so it is not a lost change. These rows are reported
    // separately below rather than silently dropped — a probe that cannot write is itself a
    // finding, just not a finding about Sync.
    lost += changes.filter((c: Change) => c.issuedMs !== 0 && c.writeError === null && c.arriveSec === null).length;
    unissued += changes.filter((c: Change) => c.issuedMs === 0).length;
    unwritten += changes.filter((c: Change) => c.issuedMs !== 0 && c.writeError !== null).length;
    for (const c of changes) {
      if (c.writeError !== null) writeErrors.push(`${c.op}: ${c.writeError}`);
    }
    // Only UNDERSHOOT counts against the model: a write going out sooner than the note's own window
    // allows means the throttle shortened or went. Overshoot is normal — the uploader is shared, so
    // a write can queue behind another note's upload — and shows in the table without comment.
    //
    // Tested against `up`, not against arrival. The floor is a claim about when a write goes UP, and
    // arrival is that plus a download: testing it there padded the check with ~1.5s that has nothing
    // to do with the throttle, which made undershoot harder to see. `up` is now measured per note
    // from the server's own record, so the comparison is direct — it is exactly the `exp-up` column.
    // A row with no carrier on record is skipped: no measurement, no verdict.
    bad += changes.filter((c: Change) =>
      c.uploadSec !== null && !Number.isNaN(c.expected) && c.uploadSec < c.expected - UNDERSHOOT_MARGIN_SEC).length;
  }

  if (unissued > 0) {
    // Distinct from loss, and the fix is a knob rather than a bug report: the run's own budget ran
    // out before the history did.
    console.error(`\n  --  ${unissued} step(s) never ran: the history outlasts the ${GIVE_UP_MS / 1000}s budget`);
  }
  if (unwritten > 0) {
    // A hard failure, like `lost` — but of the APPARATUS, not of Sync, and the wording has to say
    // so. These rows measure nothing: the token never reached the writer's own disk, so its
    // absence on the peer is arithmetic, not evidence.
    console.error(`\n  FAIL ${unwritten} write(s) never landed on the writing node — the probe could not write, so this run measures nothing about propagation`);
    for (const e of writeErrors) console.error(`        ${e}`);
    console.error(`        (unlike the run path, this probe writes via appendLine/createNote, which do NOT read back —`);
    console.error(`         so a write that fails here is only ever visible as the error above.)`);
  }
  if (lost > 0) {
    console.error(`\n  FAIL ${lost} issued change(s) never arrived within ${GIVE_UP_MS / 1000}s`);
  }
  if (lost > 0 || unwritten > 0) process.exit(1);
  // The only line that is a judgement rather than data: whether anything beat the modelled floor.
  // check-assumptions reads it. Overshoot and blank rows are visible in the table and need no prose.
  console.log(bad === 0 ? `\n  ok  no change beat the ${CYCLE_SEC}s per-note floor` : `\n  --  ${bad} change(s) beat the ${CYCLE_SEC}s per-note floor`);
}

/** However this ends, put the network back. A probe that leaves a node cut off is worse than no
 *  probe: every rep after it measures a partition nobody asked for. Same guarantee as
 *  probe-sync-versions, which partitions deliberately for the same reason. */
async function reconnectAll(): Promise<void> {
  for (const n of names) {
    try { await isolator.connect(n); } catch { /* best effort — already connected is fine */ }
  }
}

main()
  .then(reconnectAll)
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await reconnectAll();
    console.error(`  (reconnected ${names.join(", ")} on the way out)`);
    process.exit(1);
  });
