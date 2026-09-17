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
// RESOLUTION. Only two of the three columns are measured: `total` (write confirmed on n1 -> readable
// on n2) and `upload` (write -> n1's own `sync:status` stops reporting anything outstanding).
// Download is the subtraction, so it carries both errors, and `upload` is biased high — the probe
// caps at 1s, and n1 keeps reporting "pending" briefly after n2 already has the data. Anything below
// NOISE_SEC is therefore reported as `<1s` rather than as a number, since that is genuinely all this
// method can say. The seconds of delay are all on the upload side; the download never approaches
// them.
//
// THE SERVER COUNTER, per slot, for both nodes. `sync:history file=<n> total` is the call that
// returns it. Watched here rather than sampled once, because the question it answers is a timing
// one: does either node's counter move ahead of the file arriving? Measured, no — n1's counter,
// n2's counter and the token hitting n2's disk all land in the SAME 0.5s slot, every row. n1's own
// count does not reflect n1's own edit until the peer has it, so the counter tracks delivery rather
// than upload, and cannot be used as a "my push is out" signal.
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
import { ObsidianDriver } from "./driver.js";
import { NOTE_DIR } from "./types.js";
import { parse, type History } from "./dsl.js";
import { NetworkIsolator } from "./isolate.js";
import {
  CounterLane, FileLane, Live, MARK, fileMark, readReading, renderLanes, slot, syncMark,
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
  /** Seconds since THAT NOTE's previous upload finished — what the throttle acts on. `Infinity` for
   *  a note's first write. NaN-expected rows are partitioned, where the throttle does not govern. */
  sinceLast: number;
  created: boolean;
  expected: number;
  issuedMs: number;
  /** When the write COMMAND returned. Until then n1 has nothing pending and `sync:status` reads
   *  `synced` for the trivial reason that the write has not happened yet — timing the upload from
   *  before this point records ~0s for a push never issued. */
  writtenMs: number | null;
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
      sinceLast: Infinity, expected: NaN,
      issuedMs: 0, writtenMs: null, uploadSec: null, arriveSec: null,
    }];
  });
  let writeIdx = 0; // which planned row the next write step fills in
  const lastUploadAt = new Map<string, number>();
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
        const prev = lastUploadAt.get(c.note);
        c.sinceLast = prev === undefined ? Infinity : (Date.now() - prev) / 1000;
        // Partitioned: delivery is governed by the cut, not the throttle, so the floor predicts
        // nothing and is reported as n/a rather than as a number to compare against.
        c.expected = offline.size > 0 ? NaN : Math.max(0, CYCLE_SEC - c.sinceLast);
        c.issuedMs = Date.now();
        // Fire and forget: awaiting here would stall the sampler, which is the whole point of the
        // rewrite. A rejected write still resolves the guard so the loop cannot wedge on it.
        void (c.created ? d.createNote(full, `${c.token}\n`) : d.appendLine(full, c.token))
          .then(() => { c.writtenMs = Date.now(); }, () => { c.writtenMs = Date.now(); });
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
      byName.get(n)!.sampleNotes(NOTE_DIR, letters.map(noteOf), CALL_CAP_MS)));
    const shotOf = (n: string) => shots[names.indexOf(n)];
    // The push probe stays separate and conditional. "skip", never a fake "synced": the guard is
    // evaluated when this slot's calls are built, and a write can complete DURING the slot —
    // resolving "synced" here let that fake reading close the upload of a push only just issued,
    // recording ~0s for it.
    const syncStates = await Promise.all(names.map((n) =>
      changes.some((c) => c.writer === n && c.uploadSec === null && c.writtenMs !== null)
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
    // `sync:status` is per NODE, so one reading cannot say which of several outstanding writes it
    // refers to. It can at least be stopped from saying something impossible: a write whose token is
    // already readable on n2 finished uploading at or before that, so a later `synced` is not its
    // upload. Those keep `uploadSec` null and print `—` — the split is genuinely unavailable, rather
    // than a number larger than the delivery it is supposed to be part of.
    //
    // Run BEFORE this slot's arrivals are detected. Within one slot the two orderings are equally
    // true, and closing first lets the ordinary case — push confirmed and token readable in the same
    // slot — still report a split, instead of blanking it on a technicality.
    names.forEach((n, i) => {
      if (syncStates[i] !== "synced") return;
      for (const c of changes) {
        if (c.writer !== n || c.uploadSec !== null || c.writtenMs === null || c.arriveSec !== null) continue;
        c.uploadSec = (now - c.issuedMs) / 1000;
        lastUploadAt.set(c.note, now);
      }
    });

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
          // Arrival proves the data is up, so it restarts the note's window too. Without this a
          // write whose upload could not be timed — anything spanning a partition — leaves
          // `lastUploadAt` unset and every later write on that note reports an idle time of `—`.
          if (!lastUploadAt.has(c.note) || lastUploadAt.get(c.note)! < now) lastUploadAt.set(c.note, now);
          pending.splice(pending.indexOf(c), 1);
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
    `    each char ~${SLOT_MS}ms   | second boundary   a/b/... note written   D/C disconnect/connect   W wait`
    + `\n    x call blocked   - not there yet   . nothing to report   (blank) not sampled`,
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

/** The note's idle time. `—` when the note has never been written before. */
const fidle = (x: number, w: number): string => (Number.isFinite(x) ? `${x.toFixed(1)}s` : "—").padStart(w);

const COLS = `    ${"operation".padEnd(20)} ${"note idle".padStart(8)}  ${"expected".padStart(9)}   ${"upload".padStart(6)}   ${"download".padStart(8)}  ${"total".padStart(8)}`;
const TABLE_HEAD = [COLS, `    ${"-".repeat(COLS.length - 4)}`];

function row(c: Change): string {
  // n1 can go on reporting "pending" after n2 can already read the change; the row cannot then be
  // decomposed, so both split columns go blank rather than printing a negative dressed up as "<1s".
  const undecomposable = c.arriveSec !== null && c.uploadSec !== null && c.uploadSec > c.arriveSec + NOISE_SEC;
  const down = c.arriveSec === null || c.uploadSec === null || undecomposable ? null : c.arriveSec - c.uploadSec;
  return `    ${c.op.padEnd(20)} ${fidle(c.sinceLast, 8)}  ${fexp(c.expected, 9)}   ${f(undecomposable ? null : c.uploadSec, 6)}   ${f(down, 8)}  ${f(c.arriveSec, 8)}`;
}

async function main(): Promise<void> {
  const repeat = Number(values.repeat ?? 1);
  const str = values.history ?? DEFAULT_HISTORY;
  // Round-trip through the parser so the header prints what will actually run, not what was typed.
  const steps = toSteps(parse(str), str);
  let bad = 0;
  let lost = 0;
  let unissued = 0;
  for (let r = 1; r <= repeat; r++) {
    console.log(`\n  ${historyOf(steps)}${repeat > 1 ? `   (run ${r}/${repeat})` : ""}\n`);
    // Drawn live on a TTY and returned either way, so a redirected run still gets the block. No row
    // is final until the end — with one continuous sampler an arrival can land long after later
    // steps were issued — which is exactly why the live view redraws rather than appends.
    const { changes, render } = await runAll(steps);
    for (const line of render) console.log(line);
    // Only ISSUED writes can be lost. Now that the table is planned up front, a run that hits
    // GIVE_UP_MS mid-history leaves later rows never attempted — counting those as "never arrived"
    // would report a write that was never made as a data loss.
    lost += changes.filter((c: Change) => c.issuedMs !== 0 && c.arriveSec === null).length;
    unissued += changes.filter((c: Change) => c.issuedMs === 0).length;
    // Only UNDERSHOOT counts against the model: a write going out sooner than the note's own window
    // allows means the throttle shortened or went. Overshoot is normal — the uploader is shared, so
    // a write can queue behind another note's upload — and shows in the table without comment.
    bad += changes.filter((c: Change) => c.arriveSec !== null && !Number.isNaN(c.expected) && c.arriveSec < c.expected - 2).length;
  }

  if (unissued > 0) {
    // Distinct from loss, and the fix is a knob rather than a bug report: the run's own budget ran
    // out before the history did.
    console.error(`\n  --  ${unissued} step(s) never ran: the history outlasts the ${GIVE_UP_MS / 1000}s budget`);
  }
  if (lost > 0) {
    console.error(`\n  FAIL ${lost} issued change(s) never arrived within ${GIVE_UP_MS / 1000}s`);
    process.exit(1);
  }
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
