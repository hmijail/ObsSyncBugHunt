import { test } from "node:test";
import assert from "node:assert/strict";
import { generateHistory, staleReconnect, type History, type GenParams } from "./generator.js";

// Small deterministic PRNG so the generator's *logic* is testable (production
// uses Math.random; we don't seed for replay — the system is nondeterministic).
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODES = ["n1", "n2"];

/** Replay a history through the same precondition model the generator claims. */
function assertValid(h: History) {
  const existing = new Set<string>();
  const isolated = new Set<string>();
  for (const op of h) {
    assert.ok(op.delaySec >= 1, "delaySec >= 1");
    assert.ok(NODES.includes(op.node), "node is known");
    if (op.kind === "create") {
      assert.ok(op.note, "create has a note");
      existing.add(op.note!);
    } else if (op.kind === "edit") {
      assert.ok(existing.has(op.note!), "edit targets an existing note");
      assert.ok(op.where === "append" || op.where === "prepend", "edit has a where");
    } else if (op.kind === "isolate") {
      assert.ok(!isolated.has(op.node), "isolate only a connected node");
      isolated.add(op.node);
    } else {
      assert.ok(isolated.has(op.node), "heal only an isolated node");
      isolated.delete(op.node);
    }
  }
}

test("op count lands within the requested range and first op creates", () => {
  for (let s = 1; s <= 20; s++) {
    const params: GenParams = { nodes: NODES, ops: [6, 12], rng: mulberry32(s) };
    const h = generateHistory(params);
    assert.ok(h.length >= 6 && h.length <= 12, `length ${h.length} in [6,12]`);
    assert.equal(h[0].kind, "create", "first op is create");
    assertValid(h);
  }
});

test("isolateProb=0 yields no isolation ops", () => {
  for (let s = 1; s <= 10; s++) {
    const h = generateHistory({ nodes: NODES, ops: [8, 8], isolateProb: 0, rng: mulberry32(s) });
    assert.ok(!h.some((o) => o.kind === "isolate" || o.kind === "heal"), "no isolate/heal");
    assertValid(h);
  }
});

test("isolateProb=1 produces isolation and stays valid", () => {
  let sawIsolate = false;
  for (let s = 1; s <= 20; s++) {
    const h = generateHistory({ nodes: NODES, ops: [10, 12], isolateProb: 1, rng: mulberry32(s) });
    if (h.some((o) => o.kind === "isolate")) sawIsolate = true;
    assertValid(h);
  }
  assert.ok(sawIsolate, "at least one history isolated a node");
});

test("staleReconnect: create, isolate-early, edits, heal-late, same stale node", () => {
  const h = staleReconnect({ nodes: NODES, ops: [5, 5], rng: mulberry32(7) });
  assert.equal(h[0].kind, "create");
  assert.equal(h[1].kind, "isolate");
  assert.equal(h[h.length - 1].kind, "heal");
  assert.equal(h[1].node, h[h.length - 1].node, "same node isolated then healed");
  assert.ok(h.filter((o) => o.kind === "edit").length >= 1, "has edits during the window");
  assertValid(h);
});
