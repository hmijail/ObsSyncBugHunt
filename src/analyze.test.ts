import test from "node:test";
import assert from "node:assert/strict";
import { classify, tokensIn, letterOf, buildStateCells, stateKey, renderCategoryTable, renderGroup, line, isUninteresting, type Results, type StateEntry } from "./analyze.js";

const converged = (note: string, canonical: string, conflicts: { file: string; content: string }[] = []) => ({
  note, lost: [] as string[], onlyInConflict: [] as string[], converged: true, conflictFiles: conflicts.length,
  duplicated: [] as { token: string; maxCount: number }[],
  conflictMeta: conflicts.map((c) => ({ file: c.file, device: "n1", wellFormed: true, holders: ["n1", "n2"] })),
  canonical, conflicts,
});

function fixture(opts: {
  ok?: boolean; unsynced?: boolean; syncTimedOut?: boolean;
  notes: ReturnType<typeof converged>[];
}): Results {
  return {
    verdict: { ok: opts.ok ?? true, notes: opts.notes },
    timings: { convergenceSec: 8, syncTimedOut: opts.syncTimedOut ?? false, unsynced: opts.unsynced ?? false },
    observations: opts.notes.map((n) => ({ node: "n1", note: n.note, canonical: n.canonical, conflicts: n.conflicts })),
    noteLetters: Object.fromEntries(opts.notes.map((n) => [n.note, n.note.split("/")[1] ?? n.note])),
  };
}

test("classify: ranks NOUPLOAD > TIMEOUT > LOST > DUPL > SYNCBAD > PASS", () => {
  assert.equal(classify(fixture({ unsynced: true, notes: [] })), "NOUPLOAD");
  assert.equal(classify(fixture({ syncTimedOut: true, notes: [] })), "TIMEOUT");
  assert.equal(classify(fixture({ notes: [{ ...converged("bughunt/a", "x"), lost: ["(n1-1-a)"] }] })), "LOST");
  assert.equal(classify(fixture({ notes: [{ ...converged("bughunt/a", "x"), duplicated: [{ token: "(n1-1-a)", maxCount: 2 }] }] })), "DUPL");
  assert.equal(classify(fixture({ notes: [{ ...converged("bughunt/a", "x"), converged: false }] })), "SYNCBAD");
  assert.equal(classify(fixture({ notes: [converged("bughunt/a", "(n1-1-a)")] })), "PASS");
});

test("tokensIn: format-agnostic extraction, sorted + deduped", () => {
  assert.deepEqual(tokensIn("(n1-2-a)\n(n1-1-a)\n(n1-1-a)"), ["(n1-1-a)", "(n1-2-a)"]);
  assert.deepEqual(tokensIn("(op-n1-1)"), ["(op-n1-1)"]); // old token shape still matches
  assert.deepEqual(tokensIn(""), []);
});

test("letterOf: prefers noteLetters when present", () => {
  const fullname = "bughunt/01T010204-a-N1DAa";
  assert.equal(letterOf(fullname, { [fullname]: "z" }), "z"); // explicit mapping wins even if "wrong"
});

test("letterOf: recovers the letter by regex when noteLetters is absent (older results.json)", () => {
  assert.equal(letterOf("bughunt/01T010204-a-N1DAa", undefined), "a");
  assert.equal(letterOf("bughunt/01T010850-b-N1DN2DN1AaN2Aa", {}), "b");
});

test("letterOf: recovers the letter even with a collision-suffixed rep id", () => {
  assert.equal(letterOf("bughunt/01T010204-2-a-N1DAa", undefined), "a");
});

test("letterOf: falls back to the raw fullname when the naming convention doesn't match at all", () => {
  assert.equal(letterOf("not-a-recognized-shape", undefined), "not-a-recognized-shape");
});

test("buildStateCells: clean converged note -> just its token list under its letter", () => {
  const r = fixture({ notes: [converged("bughunt/a", "(n1-1-a) (n1-2-a)")] });
  assert.deepEqual(buildStateCells(r), { a: "(n1-1-a) (n1-2-a)" });
});

test("buildStateCells: one conflict file -> its own <letter>-Conf-<device> column", () => {
  const r = fixture({
    notes: [converged("bughunt/a", "(n1-1-a)", [{ file: "bughunt/a (Conflicted copy n1 202606300000).md", content: "(n1-6-a)" }])],
  });
  assert.deepEqual(buildStateCells(r), { a: "(n1-1-a)", "a-Conf-n1": "(n1-6-a)" });
});

test("buildStateCells: two conflict files from the SAME device -> disambiguated with an index", () => {
  const r = fixture({
    notes: [converged("bughunt/a", "(n1-1-a)", [
      { file: "bughunt/a (Conflicted copy n1 202606300000).md", content: "(n1-6-a)" },
      { file: "bughunt/a (Conflicted copy n1 202606300001).md", content: "(n1-7-a)" },
    ])],
  });
  assert.deepEqual(buildStateCells(r), { a: "(n1-1-a)", "a-Conf-n1": "(n1-6-a)", "a-Conf-n1-2": "(n1-7-a)" });
});

test("buildStateCells: a diverged note -> DIVERGED, no per-node detail", () => {
  const r = fixture({ notes: [{ ...converged("bughunt/a", "(n1-1-a)"), converged: false }] });
  assert.deepEqual(buildStateCells(r), { a: "DIVERGED" });
});

test("buildStateCells: older results.json without observations -> null (excluded from tables)", () => {
  const r = fixture({ notes: [converged("bughunt/a", "(n1-1-a)")] });
  delete (r as { observations?: unknown }).observations;
  assert.equal(buildStateCells(r), null);
});

test("stateKey: identical cells in different insertion order produce the same key", () => {
  const k1 = stateKey({ a: "x", b: "y" });
  const k2 = stateKey({ b: "y", a: "x" });
  assert.equal(k1, k2);
});

test("renderCategoryTable: PASS gets no reps column; non-PASS does", () => {
  const entries = new Map<string, StateEntry>([
    ["k1", { cells: { a: "(n1-1-a)" }, count: 3, reps: ["r1", "r2", "r3"] }],
  ]);
  const passTable = renderCategoryTable("PASS", entries);
  assert.ok(!passTable.includes("| reps |"), "PASS table must not have a reps column");
  const lostTable = renderCategoryTable("LOST", entries);
  assert.ok(lostTable.includes("| reps |"), "non-PASS table must have a reps column");
  assert.ok(lostTable.includes("r1, r2, r3"), "reps are comma-joined");
});

test("renderCategoryTable: rows sorted by descending count", () => {
  const entries = new Map<string, StateEntry>([
    ["k1", { cells: { a: "x" }, count: 1, reps: ["r1"] }],
    ["k2", { cells: { a: "y" }, count: 5, reps: ["r2"] }],
  ]);
  const md = renderCategoryTable("LOST", entries);
  const lines = md.split("\n").filter((l) => l.startsWith("| 1") || l.startsWith("| 5"));
  assert.ok(lines[0].startsWith("| 5"), "the higher count row comes first");
});

test("renderCategoryTable: column set is the union of all entries' cells; missing cells render blank", () => {
  const entries = new Map<string, StateEntry>([
    ["k1", { cells: { a: "x", "a-Conf-n1": "y" }, count: 1, reps: ["r1"] }],
    ["k2", { cells: { a: "z" }, count: 1, reps: ["r2"] }],
  ]);
  const md = renderCategoryTable("PASS", entries);
  assert.match(md, /\| count \| a \| a-Conf-n1 \|/);
  assert.ok(md.includes("| 1 | z |  |"), "row without a conflict column renders a blank cell");
});

test("renderGroup: only non-empty categories appear, in ranked order", () => {
  const g = {
    reps: 2, pass: 1, fail: 1, lost: 1, serverDropped: 0, neverRegistered: 1,
    duplReps: 0, diffReps: 0, unsyncedReps: 0, timeouts: 0, conv: [8, 9],
    obsfail: 0, unknown: 0,
    categories: new Map([
      ["PASS", new Map<string, StateEntry>([["k1", { cells: { a: "x" }, count: 1, reps: ["r1"] }]])],
      ["LOST", new Map<string, StateEntry>([["k2", { cells: { a: "y" }, count: 1, reps: ["r2"] }]])],
    ]),
  };
  const md = renderGroup("N1AaWN2Aa", g);
  const lostIdx = md.indexOf("## LOST");
  const passIdx = md.indexOf("## PASS");
  assert.ok(lostIdx > 0 && passIdx > 0 && lostIdx < passIdx, "LOST (ranked above PASS) renders first");
  assert.ok(!md.includes("## DUPL"), "an empty category is skipped entirely");
  assert.ok(md.startsWith("# N1AaWN2Aa"), "history string heads the section");
});

test("line: only non-zero fields are shown, and convergenceSec reports min/avg/max/span", () => {
  const g = {
    reps: 3, pass: 3, fail: 0, lost: 0, serverDropped: 0, neverRegistered: 0,
    duplReps: 0, diffReps: 0, unsyncedReps: 0, timeouts: 0, conv: [5, 8, 11],
    obsfail: 0, unknown: 0, categories: new Map(),
  };
  const l = line(g);
  assert.ok(l.includes("reps=3 pass=3"));
  assert.ok(!l.includes("fail="), "a zero field is omitted");
  assert.ok(l.includes("min=5 avg=8 max=11 span=6"));
});

test("isUninteresting: all-PASS reps landing in the same state -> true", () => {
  const g = {
    reps: 3, pass: 3, fail: 0, lost: 0, serverDropped: 0, neverRegistered: 0,
    duplReps: 0, diffReps: 0, unsyncedReps: 0, timeouts: 0, conv: [5, 8, 11],
    obsfail: 0, unknown: 0,
    categories: new Map([
      ["PASS", new Map<string, StateEntry>([["k1", { cells: { a: "x" }, count: 3, reps: ["r1", "r2", "r3"] }]])],
    ]),
  };
  assert.equal(isUninteresting(g), true);
});

test("isUninteresting: all-PASS but reps land in DIFFERENT states -> false (there's variety to show)", () => {
  const g = {
    reps: 2, pass: 2, fail: 0, lost: 0, serverDropped: 0, neverRegistered: 0,
    duplReps: 0, diffReps: 0, unsyncedReps: 0, timeouts: 0, conv: [5, 8],
    obsfail: 0, unknown: 0,
    categories: new Map([
      ["PASS", new Map<string, StateEntry>([
        ["k1", { cells: { a: "x" }, count: 1, reps: ["r1"] }],
        ["k2", { cells: { a: "y" }, count: 1, reps: ["r2"] }],
      ])],
    ]),
  };
  assert.equal(isUninteresting(g), false);
});

test("isUninteresting: any real failure -> false, even with a single PASS state otherwise", () => {
  const g = {
    reps: 2, pass: 1, fail: 1, lost: 1, serverDropped: 0, neverRegistered: 1,
    duplReps: 0, diffReps: 0, unsyncedReps: 0, timeouts: 0, conv: [5, 8],
    obsfail: 0, unknown: 0,
    categories: new Map([
      ["PASS", new Map<string, StateEntry>([["k1", { cells: { a: "x" }, count: 1, reps: ["r1"] }]])],
      ["LOST", new Map<string, StateEntry>([["k2", { cells: { a: "y" }, count: 1, reps: ["r2"] }]])],
    ]),
  };
  assert.equal(isUninteresting(g), false);
});
