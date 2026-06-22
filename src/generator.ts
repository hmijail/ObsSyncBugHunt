// Randomized operation generator (Jepsen's "generator" concept).
//
// Produces a `History` — an ordered list of operations across nodes — to drive
// against real Obsidian nodes. The system is nondeterministic (Sync timing
// dwarfs input randomness), so we don't seed for replay: the concrete History is
// recorded as the artifact, and bug-hunting is statistical (run many, watch the
// error rate). Generation is deliberately *loose*: an op that can't actually
// apply just fails to ack at execution time and the oracle ignores it — so the
// only model state we track here is what's needed to keep ops plausible.

import type { NodeId } from "./types.js";

export type OpKind = "create" | "edit" | "isolate" | "heal";

export interface Op {
  kind: OpKind;
  node: NodeId;
  note?: string; // create / edit
  where?: "append" | "prepend"; // edit: which end of the note
  delaySec: number; // whole seconds (>=1) to wait before this op
}

export type History = Op[];

export interface GenParams {
  nodes: NodeId[];
  ops: [number, number]; // inclusive range for the number of operations
  notes?: number; // cap on distinct notes created (default 2)
  weights?: Partial<Record<OpKind, number>>;
  isolateProb?: number; // chance this history uses isolation at all (else "none")
  delaySecRange?: [number, number]; // whole seconds, default [1, 3]
  rng?: () => number; // default Math.random; injectable for tests
  noteName?: (i: number) => string; // how to name created notes
}

const DEFAULT_WEIGHTS: Record<OpKind, number> = { create: 1, edit: 4, isolate: 1, heal: 1 };

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}
function pickWeighted(rng: () => number, entries: [OpKind, number][]): OpKind {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of entries) {
    r -= w;
    if (r < 0) return k;
  }
  return entries[entries.length - 1][0];
}

/**
 * Generate a random history per `params`. Tracks only enough state (existing
 * notes, currently-isolated nodes) to keep ops plausible. Isolation is enabled
 * for the whole history with probability `isolateProb` ("maybe none" falls out).
 */
export function generateHistory(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const { nodes } = params;
  const maxNotes = params.notes ?? 2;
  const isolateProb = params.isolateProb ?? 0.7;
  const [dlo, dhi] = params.delaySecRange ?? [1, 3];
  const nameOf = params.noteName ?? ((i: number) => `note-${i}`);
  const weights: Record<OpKind, number> = { ...DEFAULT_WEIGHTS, ...params.weights };

  const useIsolation = rng() < isolateProb;
  const count = randInt(rng, params.ops[0], params.ops[1]);

  const existing: string[] = [];
  const isolated = new Set<NodeId>();
  let noteSeq = 0;
  const history: History = [];

  const delay = () => randInt(rng, dlo, dhi);

  while (history.length < count) {
    // Feasible op kinds given current state.
    const connected = nodes.filter((n) => !isolated.has(n));
    const feasible: [OpKind, number][] = [];
    if (existing.length < maxNotes) feasible.push(["create", weights.create]);
    if (existing.length > 0) feasible.push(["edit", weights.edit]);
    if (useIsolation && connected.length > 0) feasible.push(["isolate", weights.isolate]);
    if (isolated.size > 0) feasible.push(["heal", weights.heal]);

    // Must create the first note before anything else is possible.
    let kind: OpKind;
    if (existing.length === 0) kind = "create";
    else kind = pickWeighted(rng, feasible);

    if (kind === "create") {
      const note = `${nameOf(noteSeq++)}`;
      existing.push(note);
      history.push({ kind, node: pick(rng, nodes), note, delaySec: delay() });
    } else if (kind === "edit") {
      history.push({
        kind,
        node: pick(rng, nodes),
        note: pick(rng, existing),
        where: rng() < 0.5 ? "append" : "prepend",
        delaySec: delay(),
      });
    } else if (kind === "isolate") {
      const node = pick(rng, connected);
      isolated.add(node);
      history.push({ kind, node, delaySec: delay() });
    } else {
      const node = pick(rng, [...isolated]);
      isolated.delete(node);
      history.push({ kind, node, delaySec: delay() });
    }
  }

  return history;
}

/**
 * Stale-device-reconnect bias: isolate one node near the start, pile edits during
 * its offline window (on it and the others), heal it at the end. Targets the
 * reported "long-unused device floods conflicts on reconnect" failure mode.
 */
export function staleReconnect(params: GenParams): History {
  const rng = params.rng ?? Math.random;
  const { nodes } = params;
  const [dlo, dhi] = params.delaySecRange ?? [1, 3];
  const nameOf = params.noteName ?? ((i: number) => `note-${i}`);
  const delay = () => randInt(rng, dlo, dhi);
  const edits = randInt(rng, params.ops[0], params.ops[1]);

  const stale = pick(rng, nodes);
  const note = nameOf(0);
  const history: History = [];

  // Base note, created by a non-stale node when possible.
  const creator = nodes.find((n) => n !== stale) ?? stale;
  history.push({ kind: "create", node: creator, note, delaySec: delay() });
  // Isolate the stale node early.
  history.push({ kind: "isolate", node: stale, delaySec: delay() });
  // Pile edits during the offline window, on the stale node and the others.
  for (let i = 0; i < edits; i++) {
    history.push({
      kind: "edit",
      node: pick(rng, nodes),
      note,
      where: rng() < 0.5 ? "append" : "prepend",
      delaySec: delay(),
    });
  }
  // Heal late → large accumulated divergence reconciles at once.
  history.push({ kind: "heal", node: stale, delaySec: delay() });
  return history;
}
