// Randomized history generator. Emits histories in the DSL op vocabulary (see
// dsl.ts) as sequences of user actions. Nondeterminism in Sync means a history
// can pass once and fail another time, so we don't seed for replay — the concrete
// history string IS the artifact, and we repeat each one (see run.ts).
//
// `generateHistory` coordinates cross-node edits by `turns`:
//   barrier    — insert `W` before a cross-node edit (strict turns, no overlap)
//   paced      — insert a default `P` instead (a timed pause → edits sometimes race)
//   concurrent — insert nothing (maximum overlap)
// Coordination only applies while both editors are online — you can't take a turn
// across a partition. With `partitionProb>0` it also opens random `D`…`C`
// partitions (one or more nodes go offline, edits diverge, then they heal), so the
// `staleReconnect` preset is just a biased corner of this space. The result is run
// through `normalize` (see dsl.ts) so the emitted string is exactly what executes.

import { DEFAULT_PAUSE_SEC, normalize, type History } from "./dsl.js";

export type Turns = "barrier" | "paced" | "concurrent";

export interface GenParams {
  nodes: number; // node count (>=1) — numbered nodes only, the Mac is layered on top, see macEnabled
  ops: [number, number]; // inclusive range for the number of edits (counts `A` only)
  notes?: number; // distinct notes (default 1 = max contention)
  turns?: Turns; // cross-node coordination (default "barrier")
  pauseProb?: number; // chance of a default-length pause after an edit (default 0)
  partitionProb?: number; // chance per edit-step of opening a network partition (needs nodes>1; default 0)
  macEnabled?: boolean; // include the Mac (M) as an edit target; NEVER a D/C target (default false)
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
  const turns = params.turns ?? "barrier";
  const pauseProb = params.pauseProb ?? 0;
  const partitionProb = params.partitionProb ?? 0;
  const macEnabled = params.macEnabled ?? false;
  const letters = LETTERS.slice(0, Math.max(1, params.notes ?? 1));
  const count = randInt(rng, params.ops[0], params.ops[1]);

  const ops: History = [];
  let curNode: number | "mac" = 0;
  let prevEditor: number | "mac" = 0;
  // Partition state stays strictly numbered-node-only — the Mac never enters it (see
  // isOffline below), which is what keeps it structurally unselectable as a D/C target.
  const offline = new Set<number>();
  const offlineSince = new Map<number, number>(); // node -> edit index it went offline
  const isOffline = (x: number | "mac") => x !== "mac" && offline.has(x);

  const setNode = (n: number | "mac") => {
    if (n !== curNode) { ops.push(n === "mac" ? { cmd: "mac" } : { cmd: "node", node: n }); curNode = n; }
  };
  const disconnect = (v: number, at: number) => { setNode(v); ops.push({ cmd: "disconnect" }); offline.add(v); offlineSince.set(v, at); };
  const reconnect = (v: number) => {
    // Pause before healing so the online side's edits propagate before the stale
    // node rejoins with its divergent version (the conflict setup).
    ops.push({ cmd: "pause", seconds: DEFAULT_PAUSE_SEC });
    setNode(v);
    ops.push({ cmd: "connect" });
    offline.delete(v);
    offlineSince.delete(v);
  };

  for (let i = 0; i < count; i++) {
    // Maybe open a partition on a random currently-online NUMBERED node — multiple (up to
    // all) can be offline at once. The Mac is never in this pool (see GenParams.macEnabled).
    const onlineNodes: number[] = [];
    for (let x = 1; x <= nodeCount; x++) if (!offline.has(x)) onlineNodes.push(x);
    if (partitionProb > 0 && nodeCount > 1 && onlineNodes.length > 0 && rng() < partitionProb) {
      disconnect(pick(rng, onlineNodes), i);
    }
    // Heal each offline node that has lingered past the step it went offline
    // (a couple of edits, or by chance) — never open and heal in the same step.
    for (const v of [...offline]) {
      const since = offlineSince.get(v) ?? i;
      if (i > since && (i - since >= 2 || rng() < 0.4)) reconnect(v);
    }

    // Edit target: nodeCount numbered slots, plus one extra "mac" slot when enabled —
    // the Mac gets roughly the same per-node representation as any numbered node here,
    // even though it's excluded entirely from the disconnect-target draw above.
    const draw = randInt(rng, 1, nodeCount + (macEnabled ? 1 : 0));
    const n: number | "mac" = draw <= nodeCount ? draw : "mac";
    const note = pick(rng, letters);
    setNode(n);
    // Coordinate a cross-node edit per `turns`, but only while both editors are
    // online (you can't take a turn across a partition — divergence is the point).
    if (turns !== "concurrent" && prevEditor && prevEditor !== n && !isOffline(n) && !isOffline(prevEditor)) {
      ops.push(turns === "barrier" ? { cmd: "wait" } : { cmd: "pause", seconds: DEFAULT_PAUSE_SEC });
    }
    ops.push({ cmd: "append", note });
    if (rng() < pauseProb) ops.push({ cmd: "pause", seconds: DEFAULT_PAUSE_SEC });
    prevEditor = n;
  }
  for (const v of [...offline]) reconnect(v); // never leave a node partitioned at the end

  return normalize(ops);
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
    { cmd: "node", node: other }, { cmd: "append", note: "a" }, { cmd: "pause", seconds: DEFAULT_PAUSE_SEC }, // base; pause lets it propagate naturally
    { cmd: "node", node: stale }, { cmd: "disconnect" }, { cmd: "pause", seconds: 30 }, // deliberately long stale window
  ];
  let cur = stale;
  for (let i = 0; i < edits; i++) {
    const n = randInt(rng, 1, nodeCount);
    if (n !== cur) { ops.push({ cmd: "node", node: n }); cur = n; }
    ops.push({ cmd: "append", note: "a" });
  }
  if (cur !== stale) ops.push({ cmd: "node", node: stale });
  ops.push({ cmd: "connect" });
  return normalize(ops);
}
