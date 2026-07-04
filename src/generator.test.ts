import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHistory, staleReconnect } from "./generator.js";
import { serialize, type Cmd, type History } from "./dsl.js";

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
    const h = generateHistory({ nodes: 3, ops: [4, 12], turns: "paced", partitionProb: 0.3, pauseProb: 0.2, notes: 2, rng: mulberry32(s) });
    for (let i = 1; i < h.length; i++) {
      // Adjacent appends are only redundant when they target the SAME note (different
      // notes back-to-back are legitimate); the rest of COLLAPSIBLE never repeats adjacently.
      const redundant = h[i].cmd === h[i - 1].cmd && COLLAPSIBLE.includes(h[i].cmd) &&
        (h[i].cmd !== "append" || h[i].note === h[i - 1].note);
      assert.ok(!redundant, `adjacent ${h[i].cmd}: ${serialize(h)}`);
    }
  }
});

test("barrier turns: a W before every cross-node edit", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], turns: "barrier", rng: mulberry32(s) });
    assert.equal(crossNodeUncoordinated(h, "wait"), 0, `barrier should W before cross-node edits: ${serialize(h)}`);
  }
});

test("paced turns: a P (not W) before every cross-node edit", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], turns: "paced", rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "wait"), `paced uses no W: ${serialize(h)}`);
    assert.equal(crossNodeUncoordinated(h, "pause"), 0, `paced should P before cross-node edits: ${serialize(h)}`);
  }
});

test("concurrent turns: no coordination at all", () => {
  for (let s = 1; s <= 10; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], turns: "concurrent", rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "wait" || o.cmd === "pause"), `concurrent inserts no W/P: ${serialize(h)}`);
  }
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

test("partitions: a single numbered node with NO local instance still never partitions (only one participant, nothing to stay online)", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 1, ops: [4, 8], partitionProb: 1, rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "disconnect"), `unexpected partition with only 1 participant: ${serialize(h)}`);
  }
});

test("staleReconnect: disconnect early, pause, edits, reconnect", () => {
  const h = staleReconnect({ nodes: 2, ops: [4, 4], rng: mulberry32(3) });
  assert.ok(h.some((o) => o.cmd === "disconnect"));
  assert.ok(h.some((o) => o.cmd === "connect"));
  assert.ok(h.some((o) => o.cmd === "pause"));
  assert.equal(h[h.length - 1].cmd, "connect", "ends by reconnecting the stale node");
});
