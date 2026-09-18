import test from "node:test";
import assert from "node:assert/strict";
import { renderLanes, slot, CounterLane, FileLane, Live, MARK, fileMark, physicalRows, RULER_LANE, syncMark, type Slot } from "./timeline.js";

/** The lane content, with its label stripped — what the eye actually reads along the row. Sliced at
 *  the width the renderer itself uses, never trimmed: a leading or trailing space in a lane is real
 *  data ("did not look"), so trimming it would hide exactly what these tests are checking. */
const body = (line: string, lanes: string[]): string =>
  line.slice(6 + Math.max(...lanes.map((l) => l.length), RULER_LANE.length) + 2);

/** renderLanes puts the seconds ruler FIRST, then the lanes in the order given. Every test below
 *  wants a lane, so they all go through this rather than indexing the raw array. */
const lane = (slots: Slot[], lanes: string[], which: string): string =>
  body(renderLanes(slots, lanes)[1 + lanes.indexOf(which)], lanes);
/** The ruler itself. */
const rulerOf = (slots: Slot[], lanes: string[]): string => body(renderLanes(slots, lanes)[0], lanes);

const build = (spec: [number, Record<string, string>][]): Slot[] =>
  spec.map(([t, marks]) => {
    const s = slot(t);
    for (const [lane, ch] of Object.entries(marks)) s.marks.set(lane, ch);
    return s;
  });

test("renderLanes: a lane that was never sampled renders spaces, not dots", () => {
  // The distinction the whole reconstruction rests on: `.` means "looked, nothing changed";
  // a space means "did not look". A strategic run leaves most lanes mostly unlooked-at, and
  // drawing dots there would claim observations that never happened.
  const slots = build([
    [0.0, { "n1 sync": ".", "n2 sync": "." }],
    [0.3, { "n1 sync": "." }], // n2 not sampled this slot
    [0.6, { "n1 sync": ".", "n2 sync": "x" }],
  ]);
  const lanes = ["n1 sync", "n2 sync"];
  assert.equal(lane(slots, lanes, lanes[0]), "...");
  assert.equal(lane(slots, lanes, lanes[1]), ". x");
});

test("renderLanes: a second containing no slot renders as ||", () => {
  const slots = build([
    [0.5, { "n1 ops": "a" }],
    [3.5, { "n1 ops": "b" }], // seconds 1 and 2 had no sampling at all
  ]);
  assert.equal(lane(slots, ["n1 ops"], "n1 ops"), "a|||b");
});

test("renderLanes: one bar per second boundary, and none before the first slot", () => {
  const slots = build([[0.1, { x: "1" }], [0.9, { x: "2" }], [1.1, { x: "3" }]]);
  assert.equal(lane(slots, ["x"], "x"), "12|3");
});

test("renderLanes: lanes stay column-aligned when nodes are sampled unequally", () => {
  // Alignment is what makes the block readable, and hand-spaced labels are how it broke before.
  const slots = build([
    [0.0, { "n1 ops": "a", "n2 ops": " ", "n2 file b": "F" }],
    [0.4, { "n1 ops": "." }],
    [1.4, { "n2 file b": "." }],
  ]);
  const lines = renderLanes(slots, ["n1 ops", "n2 ops", "n2 file b"]).slice(1); // past the ruler
  assert.equal(new Set(lines.map((l) => l.length)).size, 1, "every rendered lane is the same width");
  // ...and every lane's content starts at the same column, so the `|` bars line up vertically.
  const lanes = ["n1 ops", "n2 ops", "n2 file b"];
  for (const [i, l] of lines.entries()) assert.equal(l.indexOf(lanes[i]), 6);
  assert.deepEqual(lines.map((l) => body(l, lanes)), ["a.| ", "  | ", "F |."]);
});

test("renderLanes: no lanes, or no slots, is not an error", () => {
  assert.deepEqual(renderLanes(build([[0, { x: "." }]]), []), []);
  assert.equal(renderLanes([], ["x"]).length, 2, "a ruler and the one lane, both empty");
  assert.equal(body(renderLanes([], ["x"])[1], ["x"]), "");
});

test("fileMark: every combination of state and change gets its own character", () => {
  const m = (o: Partial<Parameters<typeof fileMark>[0]>) =>
    fileMark({ fileStatus: "present", lost: false, changed: false, conflictAppeared: false, ...o });
  assert.equal(m({}), MARK.unchanged);
  assert.equal(m({ changed: true }), MARK.updated);
  assert.equal(m({ lost: true }), MARK.missing);
  assert.equal(m({ lost: true, changed: true }), MARK.missingChanged);
  assert.equal(m({ changed: true, conflictAppeared: true }), MARK.conflicted);
  assert.equal(m({ lost: true, changed: true, conflictAppeared: true }), MARK.conflictedMissing);
  // A non-answer about the file outranks everything: we do not know what is on disk.
  assert.equal(m({ fileStatus: "absent", changed: true }), MARK.absent);
  assert.equal(m({ fileStatus: "timeout", lost: true }), MARK.blocked);
  assert.equal(m({ fileStatus: "inconsistent" }), MARK.unexpected);
  assert.equal(m({ fileStatus: "who knows" }), MARK.unparsed);
});

test("fileMark: a conflict that did not just appear does not draw c", () => {
  // `c` is edge-triggered: the conflict count RISING is the event. A later update to a note that
  // still carries an old conflict copy is an ordinary `u`.
  assert.equal(
    fileMark({ fileStatus: "present", lost: false, changed: true, conflictAppeared: false }),
    MARK.updated,
  );
  // And a conflict appearing without the note itself changing is not `c` either.
  assert.equal(
    fileMark({ fileStatus: "present", lost: false, changed: false, conflictAppeared: true }),
    MARK.unchanged,
  );
});

test("fileMark: a still-missing token outranks the conflict that carried the update", () => {
  assert.notEqual(
    fileMark({ fileStatus: "present", lost: true, changed: true, conflictAppeared: true }),
    MARK.conflicted,
  );
  assert.equal(
    fileMark({ fileStatus: "present", lost: true, changed: true, conflictAppeared: true }),
    MARK.conflictedMissing,
  );
});

test("FileLane: a look that did not answer disturbs nothing", () => {
  // The 08T171228 bug, now a unit: a timeout used to clear the remembered content, so the next
  // successful look compared against nothing and reported a change that never happened.
  const l = new FileLane();
  const look = (fileStatus: string, content = "", conflicts: string[] = []) =>
    l.look({ fileStatus, content, conflicts, tokens: [] });
  assert.equal(look("present", "one").changed, true, "first sight of content is a change");
  assert.equal(look("present", "one").changed, false);
  assert.equal(look("timeout").changed, false, "a non-answer is not itself a change");
  assert.equal(look("present", "one").changed, false, "...and did not make the same content look new");
  assert.equal(look("present", "two").changed, true, "a real change still registers");
});

test("FileLane: only a positive absent forgets the content", () => {
  const l = new FileLane();
  const look = (fileStatus: string, content = "") => l.look({ fileStatus, content, conflicts: [], tokens: [] });
  look("present", "one");
  look("absent");
  // Absent is a real answer, so the file coming back IS a change.
  assert.equal(look("present", "one").changed, true);
});

test("FileLane: a non-answer does not reset the conflict count", () => {
  // Otherwise the next real look reports a conflict "appearing" that had been there all along.
  const l = new FileLane();
  const look = (fileStatus: string, conflicts: string[] = []) =>
    l.look({ fileStatus, content: "one", conflicts, tokens: [] });
  assert.equal(look("present", ["c1"]).conflictAppeared, true);
  assert.equal(look("timeout").conflictAppeared, false);
  assert.equal(look("present", ["c1"]).conflictAppeared, false, "the copy was already there");
  assert.equal(look("present", ["c1", "c2"]).conflictAppeared, true, "a second one really did appear");
});

test("FileLane: an unanswered look reports lost as null, not a verdict", () => {
  const l = new FileLane();
  assert.equal(l.look({ fileStatus: "timeout", content: "", conflicts: [], tokens: ["(n1-1-a)"] }).lost, null);
  assert.equal(l.look({ fileStatus: "present", content: "", conflicts: [], tokens: ["(n1-1-a)"] }).lost, true);
  assert.equal(l.look({ fileStatus: "present", content: "(n1-1-a)", conflicts: [], tokens: ["(n1-1-a)"] }).lost, false);
});

test("FileLane: a token living in a conflict copy is not lost", () => {
  // The oracle calls that `onlyInConflict`, and it is a far milder thing than loss.
  const l = new FileLane();
  assert.equal(
    l.look({ fileStatus: "present", content: "(n1-1-a)", conflicts: ["(n2-2-a)"], tokens: ["(n1-1-a)", "(n2-2-a)"] }).lost,
    false,
  );
});

test("CounterLane: an unchanged reading is a dot, a change is its new value", () => {
  const c = new CounterLane();
  assert.equal(c.mark({ kind: "ok", total: 1 }), "1");
  assert.equal(c.mark({ kind: "ok", total: 1 }), MARK.unchanged);
  assert.equal(c.mark({ kind: "ok", total: 2 }), "2");
});

test("CounterLane: the three non-answers stay distinct", () => {
  // Conflating these cost real debugging time: "the call blocked" (the node is busy syncing) is a
  // different fact from "the server has no history yet", which is different again from "the CLI
  // said something we don't parse".
  const c = new CounterLane();
  assert.equal(c.mark({ kind: "timeout" }), MARK.blocked);
  assert.equal(c.mark({ kind: "absent" }), MARK.absent);
  assert.equal(c.mark({ kind: "unrecognized" }), MARK.unparsed);
});

test("CounterLane: a non-answer does not disturb the remembered value", () => {
  // A blocked call is not evidence the counter changed, so the next OK reading of the same value
  // must still read as unchanged rather than re-announcing itself.
  const c = new CounterLane();
  c.mark({ kind: "ok", total: 4 });
  c.mark({ kind: "timeout" });
  assert.equal(c.mark({ kind: "ok", total: 4 }), MARK.unchanged);
});

// --- folding a rep's log back into lanes ------------------------------------------------------
import { foldEvents } from "./timeline.js";

const NOTE = "bughunt/x-a-N1AaN2W";
const row = (r: { slots: Slot[]; lanes: string[] }, lane: string): string => {
  const line = renderLanes(r.slots, r.lanes)[1 + r.lanes.indexOf(lane)];
  return line.slice(6 + Math.max(...r.lanes.map((l) => l.length), RULER_LANE.length) + 2);
};

test("foldEvents: an append marks its own note letter on its own node's ops lane", () => {
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 0.5, kind: "appended", node: "n2", note: "b", fullname: "bughunt/x-b-N1AaN2W" },
  ]);
  assert.equal(row(r, "n1 ops"), "a ");
  assert.equal(row(r, "n2 ops"), " b");
});

test("foldEvents: a lane nothing could populate is not drawn at all", () => {
  // Better than an empty row: the block should not offer a lane that was never in play.
  const r = foldEvents([{ t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE }]);
  assert.ok(r.lanes.includes("n1 ops"));
  assert.ok(!r.lanes.includes("n1 sync"), "nothing ever probed n1's sync state");
  assert.ok(!r.lanes.includes("n2 vers a"));
});

test("foldEvents: a mid-history wait attributes its state to the one node it names", () => {
  // `wait` names a single node; the final settle names them all in `nodes`. Getting this wrong
  // would silently credit one node's sync state to another.
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "settle-poll", wait: "n2", states: ["syncing"], note: NOTE, missing: null },
    { t: 2.1, kind: "settle-poll", nodes: ["n1", "n2"], states: ["synced", "timeout"] },
  ]);
  // Columns are slot, bar, slot, bar, slot — the bars are part of the row, not decoration.
  assert.equal(row(r, "n2 sync"), " |s|x"); // unprobed, then `syncing`, then a blocked call
  assert.equal(row(r, "n1 sync"), " | |."); // the mid-history wait never looked at n1
});

test("foldEvents: an arrival and the poll after it are separate columns, both visible", () => {
  // One event, one column — so there is no contest between an `F` and the `.` of a poll logged
  // 20ms later. They are two measurements and they get two columns, which is what they are.
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.10, kind: "token-arrived", to: "n2", note: NOTE, token: "(n1-1-a)" },
    { t: 1.12, kind: "settle-poll", wait: "n2", states: ["synced"], note: NOTE, missing: 0 },
  ]);
  assert.equal(row(r, "n2 file a"), " |u.");
  assert.equal(row(r, "n1 ops"), "a|  ");
});

test("foldEvents: every measurement is its own column, however close together", () => {
  // A slot is "somebody measured something". Two nodes sampled 30ms apart are two measurements, so
  // they occupy adjacent columns rather than being folded by a proximity threshold — that threshold
  // was slicing a continuous distribution of gaps, not separating clusters.
  const r = foldEvents([
    { t: 0.10, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.10, kind: "sample", node: "n1", note: NOTE, vers: 1, versStatus: "ok", sync: "synced" },
    { t: 1.13, kind: "sample", node: "n2", note: NOTE, vers: 1, versStatus: "ok", sync: "synced" },
    { t: 2.10, kind: "sample", node: "n1", note: NOTE, vers: 2, versStatus: "ok", sync: "synced" },
  ]);
  assert.equal(row(r, "n1 vers a"), " |1 |2");
  assert.equal(row(r, "n2 vers a"), " | 1| ");
});

test("foldEvents: an event with nothing to say leaves no column behind", () => {
  // `history`, `network-probe` and `timings` mark no lane; a column of pure blanks for each would
  // be the instrument's own bookkeeping showing up as if it were an observation.
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 0.2, kind: "network-probe", node: "n1", reachable: true },
    { t: 0.3, kind: "timings", totalSec: 1 },
  ]);
  assert.equal(row(r, "n1 ops"), "a");
});

test("foldEvents: a rep with nothing appended yields no lanes rather than an empty grid", () => {
  assert.deepEqual(foldEvents([{ t: 0.1, kind: "baseline-synced" }]).lanes, []);
});

test("foldEvents: a sample carrying no counter leaves the vers lane alone", () => {
  // The waits emit a `sample` with a content reading and no `sync:history`. Marking the lane anyway
  // painted `?` down it every poll, which reads as "the CLI said something we could not parse".
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 0.2, kind: "sample", node: "n1", note: NOTE, fileStatus: "present", changed: true },
  ]);
  assert.equal(row(r, "n1 file a"), " " + MARK.updated);
  assert.equal(r.lanes.some((l) => l === "n1 vers a"), false, "no counter reading, so no counter lane");
});

test("foldEvents: a conflict appearing with an update draws c on that node's file lane", () => {
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 0.2, kind: "sample", node: "n1", note: NOTE, fileStatus: "present", changed: true, conflictAppeared: true },
    // Same note changed again later, with the conflict copy still sitting there but not NEW.
    { t: 0.3, kind: "sample", node: "n1", note: NOTE, fileStatus: "present", changed: true, conflictAppeared: false },
  ]);
  assert.equal(row(r, "n1 file a"), " " + MARK.conflicted + MARK.updated);
});

test("foldEvents: a recognized sync state gets its own mark, not the unparseable one", () => {
  // `syncing` is the most informative thing the lane can say — it is precisely when data is moving.
  // It used to render as `?`, i.e. as if the CLI had said something we could not read.
  assert.equal(syncMark("synced"), MARK.unchanged);
  assert.equal(syncMark("syncing"), "s");
  assert.equal(syncMark("paused"), "p");
  assert.equal(syncMark("timeout"), MARK.blocked);
  assert.equal(syncMark("?"), MARK.unparsed); // only a genuinely unreadable reply
});

test("foldEvents: a settle keeps only the columns where something changed", () => {
  const base: Record<string, unknown>[] = [
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "settle-poll", nodes: ["n1"], states: ["synced"], final: true },
    { t: 2.1, kind: "settle-poll", nodes: ["n1"], states: ["synced"], final: true },
    { t: 3.1, kind: "settle-poll", nodes: ["n1"], states: ["synced"], final: true },
  ];
  const quiet = foldEvents(base);
  assert.equal(quiet.quietSettleSlots, 2, "the first poll establishes the state; the next two change nothing");
  assert.equal(row(quiet, "n1 ops"), "a| ", "the establishing poll stays, its two repeats do not");

  // A settle where something happens keeps THAT column — but not the unchanging ones around it.
  // Dropping only a trailing run was defeated by anything at all happening late: one flicker in the
  // last second kept hundreds of columns of an unchanging `F`.
  const busy = foldEvents([...base, { t: 4.1, kind: "token-arrived", to: "n1", note: NOTE, token: "(t)" }]);
  assert.equal(busy.quietSettleSlots, 2, "the two repeats still go");
  assert.ok(busy.lanes.includes("n1 file a"), "and the column that said something is kept");
});

test("foldEvents: a note that is not on a node reads as absent, never as unchanged", () => {
  // The bug this pins: `absent` and `present` both drew `.`, so a lane saying "this node does not
  // have the note at all" looked identical to one saying "the note is here and unchanged".
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "sample", node: "n2", note: NOTE, vers: null, versStatus: "absent", fileStatus: "absent", sync: "synced" },
    { t: 1.2, kind: "sample", node: "n2", note: NOTE, vers: 1, versStatus: "ok", fileStatus: "present", sync: "synced" },
  ]);
  assert.equal(row(r, "n2 file a"), " |-.");
  assert.equal(row(r, "n2 vers a"), " |-1");
});

test("foldEvents: the file lane carries the state AND whether it just changed", () => {
  // One character, two facts, because both matter: `m` vs `M` is "still missing a token" vs "missing
  // and it changed right here". A column where nothing noteworthy happened holds only dots, so any
  // other character is worth stopping on.
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "sample", node: "n2", note: NOTE, fileStatus: "absent", sync: "synced" },
    { t: 1.2, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", changed: true, lost: false, sync: "synced" },
    { t: 1.3, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", changed: false, lost: false, sync: "synced" },
    { t: 1.4, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", changed: false, lost: true, sync: "synced" },
    { t: 1.5, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", changed: true, lost: true, sync: "synced" },
  ]);
  assert.equal(row(r, "n2 file a"), " |-u.mM");
});

test("foldEvents: a settle that repeats the SAME non-dot mark is still shaved", () => {
  // A losing rep's settle repeats `<` for its whole window. That is exactly as unchanging as a
  // settle repeating `.`, and an "is every mark a dot" test kept every one of those columns.
  const stuck = (t: number) => ({
    // No counter fields on purpose: a counter lane draws its first sighting as a digit and every
    // repeat as `.`, so the settle's second poll would be a genuine mark change and muddy what this
    // test is about — the file lane repeating `F`.
    t, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", lost: true, sync: "synced", final: true,
  });
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "settle-poll", nodes: ["n2"], states: ["synced"], final: true },
    stuck(1.2), stuck(1.3), stuck(1.4), stuck(1.5),
  ]);
  assert.equal(r.quietSettleSlots, 3, "the first `<` is a change; the three repeats are not");
  assert.ok(row(r, "n2 file a").endsWith("m"), "the one `m` that says something is kept");
  assert.ok(!row(r, "n2 file a").includes("mm"), "and its repeats are gone");
});

test("foldEvents: a blocked call during the settle does not count as a change", () => {
  // `x` means the call did not finish in time — it is the instrument failing to look, not the state
  // moving. A sync lane flapping `. x .` through the settle was enough to defeat the shave outright,
  // because every slot broke the trailing run.
  const poll = (t: number, st: string) => ({ t, kind: "settle-poll", nodes: ["n2"], states: [st], final: true });
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    poll(1.1, "synced"), poll(1.2, "timeout"), poll(1.3, "synced"), poll(1.4, "timeout"),
  ]);
  assert.equal(r.quietSettleSlots, 3, "only the first poll said anything; the rest are noise or repeats");
});

test("syncMark: every state Obsidian can report gets a distinct character", () => {
  // `syncing` and `stopped` both start with `s`, and deriving the mark from the first letter made
  // them identical — the worst collision available, since one means data is moving and the other
  // means Sync is switched off.
  const states = ["synced", "syncing", "paused", "error", "stopped", "offline"];
  const marks = states.map(syncMark);
  assert.equal(new Set(marks).size, states.length, `distinct marks for ${states.join(", ")}`);
  assert.equal(syncMark("timeout"), MARK.blocked);
  assert.equal(syncMark("nonsense"), MARK.unparsed);
});

test("foldEvents: a pause is an op, a loss or weirdness is not", () => {
  // `ops` is what the USER did. `L` and `!` are things the harness NOTICED about one node's copy of
  // one note, so they belong on that file lane, where a reader is already looking for trouble.
  const r = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 0.2, kind: "pausing", node: "n1", seconds: 2 },
    { t: 0.3, kind: "weirdness", what: "fs-led-counter", node: "n2", note: NOTE },
    { t: 0.4, kind: "loss-detected", node: "n2", note: NOTE, missing: ["(t)"] },
  ]);
  assert.equal(row(r, "n1 ops"), "aP  ");
  assert.equal(row(r, "n2 file a"), "  !L");
  assert.ok(!r.lanes.includes("n2 ops"), "n2 did nothing; a detection about it is not an op");
});

test("foldEvents: where the sampler watches a file lane, token-arrived does not also mark it", () => {
  // The two disagreed. `token-arrived` knows one token showed up; the sample knows whether the note
  // ended up complete. Drawing both produced adjacent columns like `Mu` for a single instant —
  // "missing a token" next to "complete" — so the sampler wins wherever it is present.
  const withSampler = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.1, kind: "sample", node: "n2", note: NOTE, fileStatus: "present", changed: true, lost: true, sync: "synced" },
    { t: 1.2, kind: "token-arrived", to: "n2", note: NOTE, token: "(t)" },
  ]);
  assert.equal(row(withSampler, "n2 file a"), " |M", "no contradicting `u` beside the `M`");

  // With no sampler — a strategic run — the arrival is the only thing that can mark the lane.
  const strategic = foldEvents([
    { t: 0.1, kind: "appended", node: "n1", note: "a", fullname: NOTE },
    { t: 1.2, kind: "token-arrived", to: "n2", note: NOTE, token: "(t)" },
  ]);
  assert.equal(row(strategic, "n2 file a"), " |u");
});

// --- what the live rewind counts ---------------------------------------------------------------
//
// Live rewinds by cursor-up, which moves PHYSICAL rows. Every row it fails to count is a row of the
// previous frame left on screen, and the next redraw strands another — the failure seen as a
// screenful of repeated table headers.

test("physicalRows: an element carrying its own newline is two rows, not one", () => {
  // The bug exactly: frame() built its two legend lines as one string with a \n between them.
  assert.equal(physicalRows(["a\nb"], 80), 2);
  assert.equal(physicalRows(["a", "b"], 80), 2);
});

test("physicalRows: a line wider than the terminal counts the rows it wraps to", () => {
  assert.equal(physicalRows(["x".repeat(80)], 80), 1);
  assert.equal(physicalRows(["x".repeat(81)], 80), 2);
  assert.equal(physicalRows(["x".repeat(240)], 80), 3);
});

test("physicalRows: an empty line still occupies a row", () => {
  // frame() uses "" as a spacer; counting it as zero would undercount every redraw.
  assert.equal(physicalRows(["", "", ""], 80), 3);
});

test("physicalRows: a lane row of marks is measured by columns, not UTF-16 units", () => {
  // The table's "—" and the lane marks are one column each; measuring .length would be right here
  // only by accident, so the check is that a full-width row of them is one line.
  assert.equal(physicalRows(["—".repeat(80)], 80), 1);
  assert.equal(physicalRows(["—".repeat(81)], 80), 2);
});

/** Drive a Live against a faked terminal, returning everything it wrote. `Live` reads isTTY at
 *  construction, so the property is set before the callback builds one. */
const onFakeTty = (rows: number, run: (live: Live) => void): string => {
  const d = (k: string, v: unknown): void => { Object.defineProperty(process.stdout, k, { value: v, configurable: true }); };
  const realWrite = process.stdout.write.bind(process.stdout);
  const realTty = process.stdout.isTTY, realCols = process.stdout.columns, realRows = process.stdout.rows;
  const out: string[] = [];
  try {
    d("isTTY", true); d("columns", 80); d("rows", rows);
    (process.stdout as unknown as { write: unknown }).write = (c: unknown) => { out.push(String(c)); return true; };
    run(new Live());
  } finally {
    (process.stdout as unknown as { write: unknown }).write = realWrite;
    d("isTTY", realTty); d("columns", realCols); d("rows", realRows);
  }
  return out.join("");
};

test("Live.log: a line printed mid-frame rewinds first, so it lands ABOVE the block", () => {
  // The bug: probe-propagation left its drivers on emit()'s console.warn fallback, so an event
  // wrote straight into rows the renderer owned and every later rewind counted from the wrong place.
  const frame = ["  header", "  row a", "  row b"];
  const seq = onFakeTty(40, (live) => { live.draw(frame); live.log("· event"); live.draw(frame); });
  const rewindThenEvent = seq.indexOf("\x1b[3A\x1b[J· event");
  assert.ok(rewindThenEvent > 0, `expected a 3-row rewind immediately before the event, got: ${JSON.stringify(seq)}`);
  // ...and the frame is redrawn after it, rather than the event sitting inside the block.
  assert.ok(seq.indexOf("  header") < rewindThenEvent, "the first frame should precede the event");
  assert.ok(seq.lastIndexOf("  header") > rewindThenEvent, "the frame should be redrawn after the event");
});

test("Live.draw: a frame taller than the window stops drawing instead of smearing", () => {
  // Cursor-up clamps at the top of the screen, so a frame that does not fit cannot be redrawn in
  // place at all; the end-of-run print is what carries it.
  const tall = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const seq = onFakeTty(24, (live) => { live.draw(["a", "b"]); live.draw(tall); live.draw(["a", "b"]); });
  assert.ok(!seq.includes("line 29"), "the too-tall frame should not be drawn");
  assert.equal(seq.split("a\nb\n").length - 1, 1, "and drawing stays off afterwards");
});

// --- the seconds ruler -------------------------------------------------------------------------

test("ruler: a label's FIRST DIGIT sits in the same column as the bar that opens its second", () => {
  // One slot per second, so every second is one mark plus its opening bar. Labels every 5s.
  const slots = build(Array.from({ length: 12 }, (_, i) => [i + 0.5, { x: "." }] as [number, Record<string, string>]));
  const lanes = ["x"];
  const bar = lane(slots, lanes, "x");
  const rule = rulerOf(slots, lanes);
  assert.equal(bar.length, rule.length, "ruler and lane must be the same width or nothing lines up");
  for (const second of [5, 10]) {
    const col = bar.indexOf("|", second === 5 ? 0 : bar.indexOf("|") + 1);
    assert.ok(col >= 0);
  }
  // The checkable form of "aligned": at every column where the ruler starts a number, the lane has
  // the bar that opens that second.
  for (let i = 0; i < rule.length; i++) {
    const isLabelStart = rule[i] !== " " && (i === 0 || rule[i - 1] === " ");
    if (!isLabelStart || i === 0) continue;
    assert.equal(bar[i], MARK.second, `a label starts at column ${i}, so that column must be a second boundary`);
  }
  // And the numbers are the seconds those bars open, every 5.
  assert.deepEqual(rule.trim().split(/\s+/), ["0", "5", "10"]);
});

test("ruler: second 0 is labelled at the left edge, where no bar precedes it", () => {
  const slots = build([[0.1, { x: "." }], [1.1, { x: "." }]]);
  assert.ok(rulerOf(slots, ["x"]).startsWith("0"), "the left edge is the start of the first second");
});

test("ruler: a timeline starting mid-run labels only the multiples it actually contains", () => {
  // A reconstruction can start anywhere; the ruler must carry real second numbers, not an offset
  // from wherever the log happened to begin.
  const slots = build([[7.2, { x: "." }], [8.2, { x: "." }], [9.2, { x: "." }], [10.2, { x: "." }]]);
  assert.deepEqual(rulerOf(slots, ["x"]).trim().split(/\s+/), ["10"], "7 is not a multiple of 5, and 10 is where its bar is");
});

test("ruler: a label that would collide with the previous one is dropped, not merged", () => {
  // Pathological but reachable: seconds one column wide and labels long enough to overrun the step.
  // A gap in the ruler is readable; two numbers run together are not.
  const slots = build([[1000.5, { x: "." }], [1001.5, { x: "." }], [1005.5, { x: "." }]]);
  const rule = rulerOf(slots, ["x"]);
  assert.ok(!/\d{5,}/.test(rule), `no two labels may merge into one run of digits: ${JSON.stringify(rule)}`);
});
