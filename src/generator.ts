// Randomized history generator. Emits histories in the DSL op vocabulary (see
// dsl.ts) as sequences of user actions. Nondeterminism in Sync means a history
// can pass once and fail another time, so we don't seed for replay — the concrete
// history string IS the artifact, and we repeat each one (see run.ts).
//
// `generateHistory` is online-only: benign (`concurrent:false`) inserts a `W`
// before every cross-node edit so they never overlap; aggressive omits it.
// `staleReconnect` is the partition preset (disconnect early, pile edits, heal).
// (Random mid-history isolation is deferred; hand-write it as a HISTORY string.)

import type { History } from "./dsl.js";

export interface GenParams {
  nodes: number; // node count (>=1)
  ops: [number, number]; // inclusive range for the number of edits
  notes?: number; // distinct notes (default 1 = max contention)
  concurrent?: boolean; // false (benign) => wait-for-sync before cross-node edits
  pauseProb?: number; // chance of a ~10s pause after an edit (default 0)
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
  const letters = LETTERS.slice(0, Math.max(1, params.notes ?? 1));
  const count = randInt(rng, params.ops[0], params.ops[1]);

  const ops: History = [];
  let curNode = 0;
  let curNote = "";
  let prevEditor = 0;
  for (let i = 0; i < count; i++) {
    const n = randInt(rng, 1, nodeCount);
    const note = pick(rng, letters);
    if (n !== curNode) { ops.push({ cmd: "node", node: n }); curNode = n; }
    if (note !== curNote) { ops.push({ cmd: "select", note }); curNote = note; }
    // Benign: the user waits for sync before a different node edits the note (so it
    // propagates → append-contention). Aggressive omits it (concurrent → maybe
    // create-create, maybe append-contention; the executor creates-or-appends by
    // local presence). The first edit to a note creates it.
    if (!concurrent && prevEditor && prevEditor !== n) ops.push({ cmd: "wait" });
    ops.push({ cmd: "append" });
    if (rng() < pauseProb) ops.push({ cmd: "pause", seconds: 10 });
    prevEditor = n;
  }
  return ops;
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
