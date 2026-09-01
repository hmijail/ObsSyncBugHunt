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

import { DEFAULT_PAUSE_SEC, normalize, parse, serialize, type History } from "./dsl.js";

/**
 * What the generator FORCES at a cross-node hand-off, written in the DSL itself:
 *
 *     W        wait until synced before handing over   (the default)
 *     P        a DEFAULT_PAUSE_SEC pause
 *     P60      a 60s pause
 *     WP30     wait for synced, then 30s more
 *     (empty)  nothing — hand over instantly
 *
 * "Forced" is the load-bearing word. This governs ONLY the hand-off; the `W`s and `P`s elsewhere in
 * a history come from their own draw weights, so an empty value does not mean a history without
 * waits, it means one where the hand-off itself imposes none. That last case is not a realistic
 * Obsidian usage pattern — it is a stress test, asking whether Sync copes when a user switches
 * devices with no settling at all.
 *
 * Only `W` and `P` are accepted. An `A` would silently inflate the edit count; a `D` would corrupt
 * the offline tracking the generator and normalize both rely on. So this rejects rather than
 * ignores.
 */
export function parseForcedTurns(spec: string): History {
  const ops = parse(spec);
  const bad = ops.find((o) => o.cmd !== "wait" && o.cmd !== "pause");
  if (bad) {
    throw new Error(
      `--forced-turns/FORCED_TURNS may only contain W and P ops, got "${bad.cmd}" in "${spec}".\n` +
      `  Accepted: W (wait for synced), P or P<seconds> (pause), a combination like WP30, or empty\n` +
      `  for no forced hand-off at all.`,
    );
  }
  return ops;
}

/** What `FORCED_TURNS` defaults to when unset: wait for synced before handing over. */
export const DEFAULT_FORCED_TURNS: History = [{ cmd: "wait" }];
/** For error messages and logs — the DSL spelling of whatever is in force. */
export const showForcedTurns = (h: History): string => serialize(h) || "(none)";

export interface GenParams {
  nodes: number; // node count (>=1) — numbered nodes only, the local instance is layered on top
  ops: [number, number]; // inclusive range for the number of EDITS (counts `A` only)
  notes?: number; // distinct notes (default 1 = max contention)
  prefix?: History; // fixed ops every history opens with — setup, not part of the `ops` count
  forcedTurns?: History; // ops spliced in at a cross-node hand-off (default: a single W)
  waitProb?: number; // draw weight for a standalone `W`, relative to an append's 1 (default 0.2)
  pauseProb?: number; // draw weight for `P`, relative to an append's weight of 1 (default 0.3)
  partitionProb?: number; // draw weight for `D` and for `C`, each relative to 1 (default 0.4)
  pauseSec?: number; // ordinary pause length (default DEFAULT_PAUSE_SEC)
  longPauseProb?: number; // chance an emitted pause is a LONG one rather than pauseSec (default 0.25)
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
/** Draw weight for `D` and for `C`. Non-zero by default because a partition is the fault this
 *  harness exists to explore, and a default soak that never opens one is exercising the least
 *  interesting corner of the space. */
const DEFAULT_PARTITION_PROB = 0.4;
/** How often a pause is a long one — CONDITIONAL on one being emitted at all, since `pauseProb`
 *  decides whether there is a pause and this only decides its length. So a quarter of the pauses in
 *  a history are long: often enough that a soak crosses the boundary regularly, rare enough that
 *  most histories stay quick. */
const DEFAULT_LONG_PAUSE_PROB = 0.25;
/** Draw weight for a standalone `W` — "the user waited for it to show up", which is a different act
 *  from the hand-off turn FORCED_TURNS imposes. Judgement, like the long-pause weight: enough to
 *  vary the shape without swamping histories in waits. With FORCED_TURNS=W a drawn W landing beside
 *  a forced one just collapses, so this mostly shows up when the forced turn is a pause or nothing. */
const DEFAULT_WAIT_PROB = 0.2;

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz".split("");

type Kind = "append" | "disconnect" | "connect" | "pause" | "wait";

export function generateHistory(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const nodeCount = params.nodes;
  const forcedTurns = params.forcedTurns ?? DEFAULT_FORCED_TURNS;
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
    ["disconnect", params.partitionProb ?? DEFAULT_PARTITION_PROB],
    ["connect", params.partitionProb ?? DEFAULT_PARTITION_PROB],
    ["pause", params.pauseProb ?? DEFAULT_PAUSE_PROB],
    ["wait", params.waitProb ?? DEFAULT_WAIT_PROB],
  ];
  const total = weights.reduce((s, [, w]) => s + w, 0);
  const drawKind = (): Kind => {
    let r = rng() * total;
    for (const [kind, w] of weights) if ((r -= w) < 0) return kind;
    return "append"; // unreachable except for float drift; an append always has weight
  };

  // A fixed opening, e.g. PREFIX=N1AaWN2PW: get a note created and settled on both nodes BEFORE the
  // generated part starts. Creation and modification are not the same operation to Sync — a new
  // note reaches the other node in ~1s, an edit to an existing one in ~10s (measured; see
  // docs/DESIGN.md) — so without a prefix every history spends its first edit in a regime the rest
  // of it never revisits. Prefix appends deliberately do NOT count toward `ops`: that is the size
  // of the experiment, and this is setup.
  const ops: History = (params.prefix ?? []).map((o) => ({ ...o }));
  let curNode: number | "local" = 0;
  let prevEditor: number | "local" = 0;
  let appends = 0;
  // Numbered nodes only. The local instance is structurally absent from this set, which is what
  // keeps it unselectable as a D/C target — see pickNumbered.
  const offline = new Set<number>();

  // Replay the prefix's effect on the cursor, the last editor and who is offline, so the generated
  // part continues from where it actually left off — otherwise the first generated append could
  // miss its forced hand-off turn, or a node the prefix disconnected would never be reconnected.
  for (const op of ops) {
    if (op.cmd === "node") { curNode = op.node!; }
    else if (op.cmd === "local") { curNode = "local"; }
    else if (op.cmd === "append") { prevEditor = curNode; }
    else if (op.cmd === "disconnect" && curNode !== "local") offline.add(curNode);
    else if (op.cmd === "connect" && curNode !== "local") offline.delete(curNode);
  }

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
        // Force a turn at the hand-off, emitted BEFORE the cursor moves so it runs on the node that
        // just edited: `N1AaWN2Aa`, not `N1AaN2WAa`.
        //
        // `W` waits on whichever node is ACTIVE, and all it ever establishes is that THAT node's own
        // client reports `synced` — never a verified fact about the server or the peer. A sync can
        // still be pending with no way for anyone to know (docs/cli-trust.md). So the placement
        // decides which client's self-report gates the hand-off:
        //
        //   old node (this)  "my device says I'm good to go" — precisely what a user checks before
        //                    picking up the other device, blind spot and all
        //   new node (was)   n2 saying "I'm synced", which it can report while entirely unaware
        //                    n1's edit exists: a check no user performs, on a signal saying less
        //
        // No online/offline condition: a `W` across a partition is inert and normalize drops it,
        // and a `P` across one lengthens divergence, which is what we want to sample.
        if (prevEditor && prevEditor !== n) for (const t of forcedTurns) ops.push({ ...t });
        setNode(n);
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
      // A standalone wait — "the user waited for it to show up" — which the hand-off turn cannot
      // express: that only fires on a node CHANGE, so `N1AaWAb` (wait for your own sync, then edit
      // again) was unreachable. Emitted freely; normalize drops it if it turns out to be inert.
      case "wait":
        ops.push({ cmd: "wait" });
        break;
    }
  }

  // Never leave a node partitioned at the end, so the string is self-contained (execute.ts also
  // reconnects, but a repro script run by hand has only the string).
  for (const v of [...offline]) { setNode(v); ops.push({ cmd: "connect" }); }

  return normalize(ops);
}
