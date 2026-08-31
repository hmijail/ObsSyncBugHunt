// Did the rep actually run the history it claims? An extra, deliberately redundant layer over
// everything else in the harness.
//
// Every other check here is per-op: a `D` confirms unreachability, an `A` reads its token back, a
// `W` waits for a real `synced`. Each of those validates an op that DID run, which structurally
// cannot notice an op that ran but should not exist, or one that should have run and did not. A
// spurious `P` injected by a refactor would pass its own timing check perfectly while making the
// rep a different experiment than its name says.
//
// So this compares INTENT against EVIDENCE at the whole-history level: the expected op sequence,
// derived from the normalized DSL, against the trace the executor actually wrote to disk. The
// evidence side is deliberately re-read from the JSONL rather than accumulated in memory as the
// rep runs — a list the executor appends to as it goes would miss exactly the bugs worth catching
// (skip the op, skip the append to the list), and the JSONL is what a human would audit anyway.
//
// Two independent verdicts come out of it:
//   - traceMismatch()   the op sequence differs (catches missing, extra, or reordered ops)
//   - durationFloorSec() the run was shorter than the harness's own enforced waits allow
// The floor is the weaker of the two — a trace can match while a pause sleeps 0s — but it is
// derived from different evidence (the clock, not the event stream), so it survives a bug that
// makes the event stream itself wrong.

import { DEFAULT_PAUSE_SEC, type History } from "./dsl.js";

/** One executed step, at the granularity the trace records. Node SELECTORS produce nothing — they
 *  move a cursor, they don't act — so they never appear here. */
export type Step =
  | { op: "disconnect"; node: string }
  | { op: "connect"; node: string }
  | { op: "pause"; seconds: number }
  | { op: "append"; node: string; note: string }
  | { op: "wait"; node: string }
  | { op: "wait-skip"; node: string }
  | { op: "settle" };

export interface TraceOpts {
  /** DSL selector -> the node id that appears in the trace (`1` -> "n1", "local" -> the host id). */
  nodeName: (sel: number | "local") => string;
  wSettleSec?: number;
  finalSettleSec?: number;
}

/**
 * The steps a history MUST produce, mirroring execute.ts's own op loop — including the two cases
 * where a `W` does not wait at all:
 *   - nothing has been appended yet, so there is no note to wait on (no event at all)
 *   - the active node is offline, so waiting cannot make progress (a `wait-skip` instead)
 * and the implicit tail every history gets: reconnect whatever is still offline, then one settle.
 */
export function expectedTrace(h: History, opts: TraceOpts): Step[] {
  const steps: Step[] = [];
  let active: number | "local" = 1; // implicit starting cursor, as in dsl.ts's requiredNodes
  let haveNote = false; // an append has happened, so a W has something to wait on
  const offline = new Set<number>();

  for (const op of h) {
    switch (op.cmd) {
      case "node": active = op.node!; break;
      case "local": active = "local"; break;
      case "pause":
        steps.push({ op: "pause", seconds: op.seconds ?? DEFAULT_PAUSE_SEC });
        break;
      case "disconnect":
        steps.push({ op: "disconnect", node: opts.nodeName(active) });
        if (active !== "local") offline.add(active);
        break;
      case "connect":
        steps.push({ op: "connect", node: opts.nodeName(active) });
        if (active !== "local") offline.delete(active);
        break;
      case "append":
        steps.push({ op: "append", node: opts.nodeName(active), note: op.note! });
        haveNote = true;
        break;
      case "wait":
        if (!haveNote) break; // nothing selected to wait on — the executor breaks too
        if (active !== "local" && offline.has(active)) steps.push({ op: "wait-skip", node: opts.nodeName(active) });
        else steps.push({ op: "wait", node: opts.nodeName(active) });
        break;
    }
  }
  // The implicit tail: every node still offline is reconnected, in ascending order (the executor
  // iterates its `offline` set, which is insertion-ordered — sorted here so a history that
  // disconnects out of order still compares deterministically; see compare()'s note).
  for (const n of [...offline].sort((a, b) => a - b)) steps.push({ op: "connect", node: opts.nodeName(n) });
  steps.push({ op: "settle" });
  return steps;
}

/** The steps a rep's JSONL says actually happened. Only op-level events are considered — the
 *  poll/probe/snapshot chatter in between is evidence about HOW an op went, not about which op. */
export function actualTrace(events: Record<string, unknown>[]): Step[] {
  const steps: Step[] = [];
  for (const e of events) {
    switch (e.kind) {
      case "disconnecting": steps.push({ op: "disconnect", node: String(e.node) }); break;
      case "connecting": steps.push({ op: "connect", node: String(e.node) }); break;
      case "pausing": steps.push({ op: "pause", seconds: Number(e.seconds) }); break;
      case "appended": steps.push({ op: "append", node: String(e.node), note: String(e.note) }); break;
      case "wait-skip": steps.push({ op: "wait-skip", node: String(e.node) }); break;
      // A settle emits one synced/unsynced per NOTE, so several rows can describe one step; the
      // `wait` field marks a mid-history W and `final` the closing settle. Collapse runs of them.
      case "synced":
      case "unsynced": {
        const step: Step = e.final ? { op: "settle" } : { op: "wait", node: String(e.wait) };
        const prev = steps[steps.length - 1];
        if (prev && prev.op === step.op && (step.op === "settle" || prev.op !== "wait" || prev.node === (step as { node: string }).node)) break;
        steps.push(step);
        break;
      }
    }
  }
  return steps;
}

const show = (s: Step): string =>
  s.op === "pause" ? `pause ${s.seconds}s`
  : s.op === "append" ? `append ${s.node} ${s.note}`
  : s.op === "settle" ? "settle"
  : `${s.op} ${s.node}`;

/**
 * `null` when the trace matches, otherwise a one-line description of the FIRST divergence — the
 * first is what matters, since everything after it is downstream of the same fault.
 */
export function traceMismatch(expected: Step[], actual: Step[]): string | null {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    const e = expected[i];
    const a = actual[i];
    if (e && a && show(e) === show(a)) continue;
    const at = `at step ${i + 1}`;
    if (!a) return `${at}: history says "${show(e!)}", but the trace ends there (${actual.length} of ${expected.length} steps ran)`;
    if (!e) return `${at}: the trace has an extra "${show(a)}" the history does not call for (${actual.length} steps ran, ${expected.length} expected)`;
    return `${at}: history says "${show(e)}", trace says "${show(a)}"`;
  }
  return null;
}

/**
 * The shortest a rep of this history could honestly take, in seconds.
 *
 * Only the waits the harness ENFORCES ITSELF count: the pauses it sleeps, the quiet window each
 * live `W` must observe, and the closing settle's window. CLI and engine round-trips are
 * deliberately excluded — nothing guarantees a floor on them, so including their typical cost
 * would make this bound depend on luck rather than on code.
 *
 * There is no matching ceiling, and there cannot be: what a settle spends beyond its window is
 * however long Sync takes, which is the black box under test.
 */
export function durationFloorSec(h: History, opts: TraceOpts): number {
  const steps = expectedTrace(h, opts);
  const wSettle = opts.wSettleSec ?? 4;
  const finalSettle = opts.finalSettleSec ?? 15;
  let sec = 0;
  for (const s of steps) {
    if (s.op === "pause") sec += s.seconds;
    else if (s.op === "wait") sec += wSettle;
    else if (s.op === "settle") sec += finalSettle;
  }
  return sec;
}
