// Randomized history generator. Emits histories in the DSL op vocabulary (see dsl.ts) as sequences
// of user actions. Nondeterminism in Sync means a history can pass once and fail another time, so we
// don't seed for replay — the concrete history string IS the artifact, and we repeat each one (see
// run.ts).
//
// SHAPE: a weighted draw over op KINDS, repeated until `ops` appends have been emitted. So `OPS`
// still means "number of edits" and a history is never vacuous, while its length is emergent.
// Who and what an op applies to are secondary uniform draws inside it.
//
// The generator does NOT try to avoid emitting useless ops — it emits freely and lets `normalize`
// canonicalize afterwards (a `C` with nothing offline, a `W` on a disconnected node, a redundant
// selector and a leading pause are all dropped there). That division is deliberate: every rule the
// generator enforces up front is a bias baked into the search space, and this one previously had
// several. It used to force-heal a partition after 2 edit steps, heal at a hard-coded 0.4 per step,
// refuse to open and heal in the same step, refuse to partition unless 2+ participants existed, and
// emit a mandatory 10s pause before EVERY reconnect. Measured over 12,000 histories, the result was
// degenerate on the axis that turned out to decide outcomes: the offline window was 20s at the
// median, the 95th percentile AND the maximum, and no setting could reach the ~60s where Obsidian
// writes a conflict file instead of losing the edit. None of those rules survive.
//
// `generateHistory` still coordinates cross-node edits by `turns`, which is a mechanism rather than
// a frequency — barrier / paced / immediate are qualitatively different experimental conditions:
//   barrier   — insert `W` before a cross-node edit (strict turns, no overlap)
//   paced     — insert a `P` instead (a timed pause → edits sometimes race)
//   immediate — insert nothing; the next edit follows with no coordination at all
// ("immediate", not "concurrent": the harness is a SINGLE thread of control standing in for one
// user moving between devices, so nothing here ever runs at the same time.)

import { DEFAULT_PAUSE_SEC, normalize, type History } from "./dsl.js";

/** The single source of truth for the accepted turn modes: the type is derived from the list, so
 *  run.ts can validate an incoming --turns against it without the two drifting apart. */
export const TURN_MODES = ["barrier", "paced", "immediate"] as const;
export type Turns = (typeof TURN_MODES)[number];

export interface GenParams {
  nodes: number; // node count (>=1) — numbered nodes only, the local instance is layered on top
  ops: [number, number]; // inclusive range for the number of EDITS (counts `A` only)
  notes?: number; // distinct notes (default 1 = max contention)
  turns?: Turns; // cross-node coordination (default "barrier")
  pauseProb?: number; // draw weight for `P`, relative to an append's weight of 1 (default 0.3)
  partitionProb?: number; // draw weight for `D` and for `C`, each relative to 1 (default 0)
  pauseSec?: number; // ordinary pause length (default DEFAULT_PAUSE_SEC)
  longPauseProb?: number; // chance a pause is a LONG one instead (default: a quarter of pauseProb's)
  longPauseSec?: number; // that long length (default 100)
  localEnabled?: boolean; // include the local instance (L) as an edit target; NEVER a D/C target
  rng?: () => number; // default Math.random; injectable for tests
}

/** Long enough to clear the ~58-66s offline window measured 2026-08-31, past which Obsidian writes a
 *  conflict file rather than silently dropping the edit. Below it, the loss is ~90-100% reproducible;
 *  above it, zero. A generator that cannot reach both sides cannot find the boundary. */
const DEFAULT_LONG_PAUSE_SEC = 100;
/** Pauses are on by default. They used to be off (`PAUSE_PROB` defaulted to 0) and the only pauses a
 *  default run saw came from a rule that emitted one before every reconnect — so removing that rule
 *  would have left a default soak with no pauses at all, unable to reach the boundary above. */
const DEFAULT_PAUSE_PROB = 0.3;
/** How often a pause is a long one, given that one is emitted. A quarter of the pause weight: often
 *  enough that a soak crosses the boundary regularly, rare enough that most histories stay quick. */
const DEFAULT_LONG_PAUSE_PROB = DEFAULT_PAUSE_PROB / 4;

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

type Kind = "append" | "disconnect" | "connect" | "pause";

export function generateHistory(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const nodeCount = params.nodes;
  const turns = params.turns ?? "barrier";
  const localEnabled = params.localEnabled ?? false;
  const pauseSec = params.pauseSec ?? DEFAULT_PAUSE_SEC;
  const longPauseProb = params.longPauseProb ?? DEFAULT_LONG_PAUSE_PROB;
  const longPauseSec = params.longPauseSec ?? DEFAULT_LONG_PAUSE_SEC;
  const letters = LETTERS.slice(0, Math.max(1, params.notes ?? 1));
  const target = randInt(rng, params.ops[0], params.ops[1]);

  // An append always weighs 1; the knobs are the others' weight RELATIVE to it. So partitionProb=0.5
  // means a D is drawn half as often as an append, and 0 means never — preserving what those two
  // parameters have always meant at their extremes.
  const weights: [Kind, number][] = [
    ["append", 1],
    ["disconnect", params.partitionProb ?? 0],
    ["connect", params.partitionProb ?? 0],
    ["pause", params.pauseProb ?? DEFAULT_PAUSE_PROB],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const drawKind = (): Kind => {
    let r = rng() * total;
    for (const [kind, w] of weights) if ((r -= w) < 0) return kind;
    return "append"; // unreachable except for float drift; an append always has weight
  };

  const ops: History = [];
  let curNode: number | "local" = 0;
  let prevEditor: number | "local" = 0;
  let appends = 0;
  // Numbered nodes only. The local instance is structurally absent from this set, which is what
  // keeps it unselectable as a D/C target — see pickNumbered.
  const offline = new Set<number>();

  // No dedup here: `dropRedundantNodes` in normalize already removes a selector nothing uses.
  const setNode = (n: number | "local") => {
    ops.push(n === "local" ? { cmd: "local" } : { cmd: "node", node: n });
    curNode = n;
  };
  const pickNumbered = (): number => randInt(rng, 1, nodeCount);
  const pauseLength = (): number => (rng() < longPauseProb ? longPauseSec : pauseSec);

  while (appends < target) {
    switch (drawKind()) {
      case "append": {
        // Uniform over participants: every numbered node plus one slot for the local instance,
        // which therefore gets roughly the same representation as any node — even though it is
        // excluded entirely from the D/C draw.
        const draw = randInt(rng, 1, nodeCount + (localEnabled ? 1 : 0));
        const n: number | "local" = draw <= nodeCount ? draw : "local";
        setNode(n);
        // Coordinate a cross-node edit per `turns`. No online/offline condition: a `W` across a
        // partition is inert and normalize drops it, and a `P` across one lengthens divergence,
        // which is exactly what we want to sample.
        if (turns !== "immediate" && prevEditor && prevEditor !== n) {
          ops.push(turns === "barrier" ? { cmd: "wait" } : { cmd: "pause", seconds: pauseLength() });
        }
        ops.push({ cmd: "append", note: pick(rng, letters) });
        prevEditor = n;
        appends++;
        break;
      }
      // D and C name their own target rather than acting on whoever last edited, so a partition is
      // not tied to the edit cursor. Either may be inert (disconnecting an already-offline node,
      // connecting an online one); normalize removes those rather than this loop preventing them.
      case "disconnect": {
        const v = pickNumbered();
        setNode(v);
        ops.push({ cmd: "disconnect" });
        offline.add(v);
        break;
      }
      case "connect": {
        const v = pickNumbered();
        setNode(v);
        ops.push({ cmd: "connect" });
        offline.delete(v);
        break;
      }
      case "pause":
        ops.push({ cmd: "pause", seconds: pauseLength() });
        break;
    }
  }

  // Never leave a node partitioned at the end, so the string is self-contained (execute.ts also
  // reconnects, but a repro script run by hand has only the string).
  for (const v of [...offline]) { setNode(v); ops.push({ cmd: "connect" }); }

  return normalize(ops);
}
