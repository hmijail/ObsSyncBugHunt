// Randomized history generator. Emits histories in the DSL op vocabulary (see
// dsl.ts) as sequences of user actions. Nondeterminism in Sync means a history
// can pass once and fail another time, so we don't seed for replay — the concrete
// history string IS the artifact, and we repeat each one (see run.ts).
//
// `generateHistory`: benign (`concurrent:false`) inserts a `W` before every
// cross-node edit so they never overlap; aggressive omits it. With
// `partitionProb>0` it also opens random `D`…`C` partitions (a node goes offline,
// edits diverge across the gap, then it heals) — so the bespoke `staleReconnect`
// preset is really just a biased corner of this space. Consecutive same-node
// appends are collapsed (they add no contention).

import type { History } from "./dsl.js";

export interface GenParams {
  nodes: number; // node count (>=1)
  ops: [number, number]; // inclusive range for the number of edits
  notes?: number; // distinct notes (default 1 = max contention)
  concurrent?: boolean; // false (benign) => wait-for-sync before cross-node edits
  pauseProb?: number; // chance of a ~10s pause after an edit (default 0)
  partitionProb?: number; // chance per edit-step of opening a network partition (needs nodes>1; default 0)
  rng?: () => number; // default Math.random; injectable for tests
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

export function generateHistory(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const nodeCount = params.nodes;
  const concurrent = params.concurrent ?? false;
  const pauseProb = params.pauseProb ?? 0;
  const partitionProb = params.partitionProb ?? 0;
  const letters = LETTERS.slice(0, Math.max(1, params.notes ?? 1));
  const count = randInt(rng, params.ops[0], params.ops[1]);

  const ops: History = [];
  let curNode = 0;
  let curNote = "";
  let prevEditor = 0;
  const offline = new Set<number>(); // nodes currently partitioned
  let offlineSince = -1;

  const setNode = (n: number) => { if (n !== curNode) { ops.push({ cmd: "node", node: n }); curNode = n; } };
  const reconnectAll = () => {
    if (offline.size === 0) return;
    // Pause before healing so the online side's edits propagate to the server
    // before the stale node rejoins with its divergent version (the conflict setup).
    ops.push({ cmd: "pause", seconds: 10 });
    for (const v of [...offline]) { setNode(v); ops.push({ cmd: "connect" }); }
    offline.clear();
    offlineSince = -1;
  };

  for (let i = 0; i < count; i++) {
    // Maybe open a partition (one node at a time, and only with a peer left online).
    if (partitionProb > 0 && offline.size === 0 && nodeCount > 1 && rng() < partitionProb) {
      const victim = randInt(rng, 1, nodeCount);
      setNode(victim);
      ops.push({ cmd: "disconnect" });
      offline.add(victim);
      offlineSince = i;
    }
    // Heal an open partition after it has spanned a couple of edits (so edits can
    // diverge across it first).
    if (offline.size > 0 && (i - offlineSince >= 2 || rng() < 0.4)) reconnectAll();

    const n = randInt(rng, 1, nodeCount);
    const note = pick(rng, letters);
    setNode(n);
    if (note !== curNote) { ops.push({ cmd: "select", note }); curNote = note; }
    // Benign: wait for sync before a different node edits the note (so it propagates
    // → append-contention). But never across a partition — you can't sync a
    // disconnected node, and divergence is the whole point of one. Aggressive
    // (concurrent) omits the wait entirely. The first edit to a note creates it.
    if (!concurrent && prevEditor && prevEditor !== n && !offline.has(n) && !offline.has(prevEditor)) {
      ops.push({ cmd: "wait" });
    }
    ops.push({ cmd: "append" });
    if (rng() < pauseProb) ops.push({ cmd: "pause", seconds: 10 });
    prevEditor = n;
  }
  reconnectAll(); // never leave a node partitioned at the end (executor would heal it anyway)

  return collapseAppends(ops);
}

/** Collapse runs of consecutive appends (same active node + note, nothing between)
 *  into a single append — back-to-back local edits exercise no new sync contention. */
function collapseAppends(ops: History): History {
  return ops.filter((op, i) => !(op.cmd === "append" && ops[i - 1]?.cmd === "append"));
}

/**
 * Stale-device-reconnect preset: a node goes offline early, edits pile up (on it
 * and the others) during a long pause, then it reconnects — the "long-unused
 * device floods conflicts" shape. Single note `a`.
 */
export function staleReconnect(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const nodeCount = params.nodes;
  const edits = randInt(rng, params.ops[0], params.ops[1]);
  const stale = randInt(rng, 1, nodeCount);
  const other = stale === 1 ? Math.min(2, nodeCount) : 1;

  const ops: History = [
    { cmd: "node", node: other }, { cmd: "select", note: "a" }, { cmd: "append" }, { cmd: "pause", seconds: 10 }, // base; pause lets it propagate naturally
    { cmd: "node", node: stale }, { cmd: "disconnect" }, { cmd: "pause", seconds: 30 },
  ];
  let cur = stale;
  for (let i = 0; i < edits; i++) {
    const n = randInt(rng, 1, nodeCount);
    if (n !== cur) { ops.push({ cmd: "node", node: n }); cur = n; }
    ops.push({ cmd: "append" }); // note `a` is still selected
  }
  if (cur !== stale) ops.push({ cmd: "node", node: stale });
  ops.push({ cmd: "connect" });
  return ops;
}
