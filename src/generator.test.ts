import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHistory, staleReconnect, type GenParams } from "./generator.js";
import { serialize, type History } from "./dsl.js";

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
const crossNodeUnwaited = (h: History) => {
  // count appends whose node differs from the previous append's node with no W between
  let prev = 0;
  let waitedSince = true;
  let n = 0;
  for (const op of h) {
    if (op.cmd === "node") {/* track via append's active node below */}
    if (op.cmd === "wait") waitedSince = true;
    if (op.cmd === "append") {
      const cur = lastNode(h, op);
      if (prev && prev !== cur && !waitedSince) n++;
      prev = cur;
      waitedSince = false;
    }
  }
  return n;
};
// resolve the active node at the position of op by scanning preceding node ops
function lastNode(h: History, target: History[number]): number {
  let node = 0;
  for (const op of h) {
    if (op.cmd === "node") node = op.node!;
    if (op === target) return node;
  }
  return node;
}

test("generateHistory: edit count in range, valid ops, serializable", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [4, 10], rng: mulberry32(s) });
    assert.ok(editCount(h) >= 4 && editCount(h) <= 10);
    assert.doesNotThrow(() => serialize(h));
  }
});

test("benign (concurrent:false) waits before every cross-node edit", () => {
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], concurrent: false, rng: mulberry32(s) });
    assert.equal(crossNodeUnwaited(h), 0, `benign history should have no unwaited cross-node edits: ${serialize(h)}`);
  }
});

test("aggressive (concurrent:true) inserts no waits", () => {
  for (let s = 1; s <= 10; s++) {
    const h = generateHistory({ nodes: 2, ops: [6, 10], concurrent: true, rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.cmd === "wait"), "no W ops in concurrent mode");
  }
});

test("staleReconnect: disconnect early, pause, edits, reconnect", () => {
  const h = staleReconnect({ nodes: 2, ops: [4, 4], rng: mulberry32(3) });
  assert.ok(h.some((o) => o.cmd === "disconnect"));
  assert.ok(h.some((o) => o.cmd === "connect"));
  assert.ok(h.some((o) => o.cmd === "pause"));
  assert.equal(h[h.length - 1].cmd, "connect", "ends by reconnecting the stale node");
});
