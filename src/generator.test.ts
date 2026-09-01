import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHistory, parseForcedTurns } from "./generator.js";
import { parse, serialize, type Cmd, type History } from "./dsl.js";

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const editCount = (h: History) => h.filter((o) => o.cmd === "append").length;

// Count cross-node appends that have no coordination op (`coord`) since the previous
// append — tracks the active node inline.
const crossNodeUncoordinated = (h: History, coord: Cmd) => {
  let prev = 0, node = 0, coordSince = true, n = 0;
  for (const op of h) {
    if (op.cmd === "node") node = op.node!;
    if (op.cmd === coord) coordSince = true;
    if (op.cmd === "append") {
      if (prev && prev !== node && !coordSince) n++;
      prev = node;
      coordSince = false;
    }
  }
  return n;
};

const maxConcurrentOffline = (h: History) => {
  let cur = 0, max = 0;
  for (const op of h) {
    if (op.cmd === "disconnect") max = Math.max(max, ++cur);
    if (op.cmd === "connect") cur--;
  }
  return max;
};

const COLLAPSIBLE: Cmd[] = ["append", "disconnect", "connect", "wait", "pause"];

test("generateHistory: edit count bounded, valid ops, serializable", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [4, 10], rng: mulberry32(s) });
    assert.ok(editCount(h) >= 1 && editCount(h) <= 10); // collapse can only reduce below the upper bound
    assert.doesNotThrow(() => serialize(h));
  }
});

test("collapse: no two adjacent collapsible ops of the same kind", () => {
  for (let s = 1; s <= 25; s++) {
    const h = generateHistory({ nodes: 3, ops: [4, 12], forcedTurns: parse("P"), partitionProb: 0.3, pauseProb: 0.2, notes: 2, rng: mulberry32(s) });
    for (let i = 1; i < h.length; i++) {
      // Adjacent appends are only redundant when they target the SAME note (different
      // notes back-to-back are legitimate); the rest of COLLAPSIBLE never repeats adjacently.
      const redundant = h[i].cmd === h[i - 1].cmd && COLLAPSIBLE.includes(h[i].cmd) &&
        (h[i].cmd !== "append" || h[i].note === h[i - 1].note);
      assert.ok(!redundant, `adjacent ${h[i].cmd}: ${serialize(h)}`);
    }
  }
});

test("FORCED_TURNS=W: a W before every cross-node edit", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], forcedTurns: parse("W"), partitionProb: 0, rng: mulberry32(s) });
    assert.equal(crossNodeUncoordinated(h, "wait"), 0, `should W before cross-node edits: ${serialize(h)}`);
  }
});

test("PREFIX opens every history, and its appends do NOT count toward OPS", () => {
  // OPS is the size of the experiment; the prefix is setup, so the two ADD. The count is not exact
  // per-run because adjacent same-note appends still collapse (documented) — more notes only makes
  // that rarer, never impossible. So assert the bound that always holds, plus the fact that only an
  // ADDITIVE prefix could ever reach it: if prefix appends were counted toward OPS, 3 would be the
  // ceiling and 4 unreachable.
  let sawFull = 0;
  for (let s = 1; s <= 25; s++) {
    const h = generateHistory({
      nodes: 2, ops: [3, 3], notes: 4, prefix: parse("N1AaWN2PW"),
      waitProb: 0, pauseProb: 0, partitionProb: 0, rng: mulberry32(s),
    });
    assert.match(serialize(h), /^N1AaW/, `prefix should open the history: ${serialize(h)}`);
    const appends = h.filter((o) => o.cmd === "append").length;
    assert.ok(appends <= 4, `never more than prefix(1) + OPS(3): ${serialize(h)}`);
    if (appends === 4) sawFull++;
  }
  assert.ok(sawFull > 0, "some run should reach 4 appends, which only an additive prefix allows");
});

test("PREFIX: a node the prefix disconnects is still reconnected at the end", () => {
  // The generator replays the prefix's effect on its offline set, so it knows to heal what the
  // prefix broke — otherwise the history would end mid-partition and only execute.ts's implicit
  // reconnect would save it, leaving the STRING not self-contained.
  for (let s = 1; s <= 15; s++) {
    const h = generateHistory({
      nodes: 2, ops: [2, 2], notes: 2, prefix: parse("N1AaWN2D"),
      waitProb: 0, pauseProb: 0, partitionProb: 0, rng: mulberry32(s),
    });
    assert.equal(h[h.length - 1].cmd, "connect", `should end reconnected: ${serialize(h)}`);
  }
});

test("PREFIX: the first generated append still gets its forced hand-off turn", () => {
  // prevEditor is seeded from the prefix's last append (n1 here), so an immediately-following
  // generated append on n2 is a cross-node hand-off like any other.
  for (let s = 1; s <= 15; s++) {
    const h = generateHistory({
      nodes: 2, ops: [4, 4], notes: 4, prefix: parse("N1Aa"), forcedTurns: parse("W"),
      waitProb: 0, pauseProb: 0, partitionProb: 0, rng: mulberry32(s),
    });
    assert.equal(crossNodeUncoordinated(h, "wait"), 0, `every hand-off coordinated: ${serialize(h)}`);
  }
});

test("FORCED_TURNS is emitted on the node that just edited, not the one about to", () => {
  // `N1AaWN2Aa`, never `N1AaN2WAa`. Not cosmetic: `W` only ever means "the ACTIVE node's client
  // reports synced", not that anything actually arrived anywhere. On the old node that is the
  // glance at the sync indicator a user really takes before switching devices; on the new node it
  // would be n2 reporting synced while possibly unaware n1's edit exists at all.
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [4, 8], forcedTurns: parse("W"), waitProb: 0, pauseProb: 0, partitionProb: 0, rng: mulberry32(s) });
    for (let i = 0; i < h.length; i++) {
      if (h[i].cmd !== "wait") continue;
      // The op right after a forced W is the selector moving to the NEW node; the W therefore ran
      // while the previous editor was still active.
      assert.equal(h[i + 1]?.cmd, "node", `a forced W should be followed by the node switch: ${serialize(h)}`);
    }
  }
});

test("FORCED_TURNS=P60: the hand-off pause takes the length from the spec", () => {
  for (let s = 1; s <= 20; s++) {
    // waitProb 0 so the only W that could appear would be a forced one — there are none here.
    const h = generateHistory({ nodes: 2, ops: [6, 10], forcedTurns: parse("P60"), waitProb: 0, pauseProb: 0, rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "wait"), `a P hand-off uses no W: ${serialize(h)}`);
    assert.equal(crossNodeUncoordinated(h, "pause"), 0, `should P before cross-node edits: ${serialize(h)}`);
    for (const o of h) if (o.cmd === "pause") assert.equal(o.seconds, 60, `every pause is the forced 60s: ${serialize(h)}`);
  }
});

test("FORCED_TURNS empty: nothing is forced at the hand-off", () => {
  for (let s = 1; s <= 10; s++) {
    // The other two weights are zeroed so the ONLY thing that could emit a W or P is the hand-off:
    // waits and pauses are otherwise drawn on their own, and would say nothing about the hand-off.
    const h = generateHistory({ nodes: 2, ops: [6, 10], forcedTurns: [], waitProb: 0, pauseProb: 0, rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "wait" || o.cmd === "pause"), `nothing forced: ${serialize(h)}`);
  }
});

test("a standalone W is reachable — the hand-off turn alone could never produce one", () => {
  // `N1AaWAb`: wait for your own sync, then edit again. The forced turn only fires on a node
  // CHANGE, so with an empty hand-off spec every W here comes from the draw.
  let withWait = 0;
  for (let s = 1; s <= 30; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], forcedTurns: [], waitProb: 0.5, rng: mulberry32(s) });
    if (h.some((o) => o.cmd === "wait")) withWait++;
  }
  assert.ok(withWait > 0, "a drawn W should appear even with no forced hand-off");
});

test("parseForcedTurns: accepts W/P forms, rejects anything that would change the experiment", () => {
  assert.deepEqual(parseForcedTurns("W"), [{ cmd: "wait" }]);
  assert.deepEqual(parseForcedTurns("P"), [{ cmd: "pause", seconds: 10 }]);
  assert.deepEqual(parseForcedTurns("WP30"), [{ cmd: "wait" }, { cmd: "pause", seconds: 30 }]);
  assert.deepEqual(parseForcedTurns(""), []);
  // An A would silently inflate the edit count; a D would corrupt the offline tracking that both
  // the generator and normalize rely on. Neither may be quietly ignored.
  assert.throws(() => parseForcedTurns("Aa"), /may only contain W and P/);
  assert.throws(() => parseForcedTurns("D"), /may only contain W and P/);
  assert.throws(() => parseForcedTurns("banana"), /unexpected/);
});

test("pauses are on by default, so a default soak can reach a long offline window", () => {
  // Regression guard for the reason PAUSE_PROB stopped defaulting to 0: with no pauses at all, the
  // long-pause draw is unreachable and the generator cannot cross the ~60s boundary where Obsidian
  // writes a conflict file instead of losing the edit.
  let withPause = 0;
  for (let s = 1; s <= 40; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], rng: mulberry32(s) });
    if (h.some((o) => o.cmd === "pause")) withPause++;
  }
  assert.ok(withPause > 20, `expected most default histories to contain a pause, got ${withPause}/40`);
});

test("partitions: D/C balanced, healed by the end, and can overlap (all-offline)", () => {
  let sawConcurrent = false;
  for (let s = 1; s <= 30; s++) {
    const h = generateHistory({ nodes: 3, ops: [6, 12], partitionProb: 0.6, rng: mulberry32(s) });
    const cmds = h.map((o) => o.cmd);
    assert.equal(cmds.filter((c) => c === "disconnect").length, cmds.filter((c) => c === "connect").length, `D/C balanced: ${serialize(h)}`);
    const lastD = cmds.lastIndexOf("disconnect");
    if (lastD >= 0) assert.ok(cmds.lastIndexOf("connect") > lastD, `reconnect after last disconnect: ${serialize(h)}`);
    if (maxConcurrentOffline(h) >= 2) sawConcurrent = true;
  }
  assert.ok(sawConcurrent, "expected at least one history with 2+ nodes offline at once");
});

test("localEnabled: the local instance is picked as an edit target but is NEVER a D/C target, even under heavy partitioning", () => {
  // normalize() (called internally by generateHistory) throws if a D/C is ever emitted while
  // the local instance is the active selector — see dsl.ts's assertLocalAlwaysConnected. So
  // simply calling generateHistory without it throwing, across many seeds/configs, IS the
  // property test: any violation of "the local instance is never disconnected" would surface
  // as an uncaught exception here.
  let sawLocal = false;
  for (let s = 1; s <= 40; s++) {
    const h = generateHistory({ nodes: 3, ops: [6, 14], partitionProb: 0.6, localEnabled: true, rng: mulberry32(s) });
    if (h.some((o) => o.cmd === "local")) sawLocal = true;
  }
  assert.ok(sawLocal, "expected at least one generated history to select the local instance as an edit target");
});

test("partitions: a single numbered node + the local instance still partitions (it counts as a second participant)", () => {
  // Regression guard: partitioning used to gate on nodeCount>1 alone, so a single numbered node
  // (nodes: 1) with localEnabled never partitioned at all, regardless of partitionProb — even
  // though the local instance staying online while that one node disconnects is exactly the
  // interesting case (matches --nodes n1,l in practice).
  let sawPartition = false;
  for (let s = 1; s <= 30; s++) {
    const h = generateHistory({ nodes: 1, ops: [4, 8], partitionProb: 1, localEnabled: true, rng: mulberry32(s) });
    if (h.some((o) => o.cmd === "disconnect")) sawPartition = true;
  }
  assert.ok(sawPartition, "expected at least one partition with nodes:1 + localEnabled:true");
});

test("partitions: a single numbered node DOES partition — editing offline then resyncing is worth sampling", () => {
  // This used to be forbidden: a partition was gated on 2+ participants, on the reasoning that
  // something must stay online to diverge against. But one node going offline, accumulating edits
  // and rejoining is its own interesting case (does the upload survive?), and nothing about it
  // needs a second participant.
  let seen = 0;
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 1, ops: [4, 8], partitionProb: 1, rng: mulberry32(s) });
    if (h.some((o) => o.cmd === "disconnect")) seen++;
  }
  assert.ok(seen > 0, "a single node should be able to partition");
});
