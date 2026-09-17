// The shortest a history could honestly take, in seconds.
//
// A deliberately blunt cross-check, and the only survivor of a larger idea. It was paired with a
// check that compared the executed op sequence against the history — but that compared the executor
// against a hand-written MODEL of the executor, so a disagreement was as likely to mean the model
// was wrong, and once it did (the model reconnected nodes in a different order than the executor,
// which would have aborted valid runs). This has no model: it is arithmetic on the history string,
// checked against a clock.
//
// Only waits the harness ENFORCES ITSELF count. Round-trips to obsidian-cli and to the container
// engine are given a nominal floor far under anything ever observed, so the bound never depends on
// the machine being fast. There is deliberately no CEILING and there cannot be: what a settle
// spends beyond its window is however long Sync takes, which is the black box under test.
//
// Compared against the HISTORY's own span (first op to last), not the whole rep — see execute.ts.
// That keeps the closing settle out of both sides of the inequality, so this needs no term for it.

import { DEFAULT_PAUSE_SEC, type History } from "./dsl.js";

/** One obsidian-cli or engine round-trip (`D`, `C`, `A`). Observed 0.2-0.4s. */
const OP_MIN_SEC = 0.1;

/**
 * Every term is unconditional, which is the point — `normalize` has already removed the ops that
 * would not have run (a `W` on an offline node, a `W` before any append, a leading pause), so there
 * is nothing here to get wrong. Node selectors cost nothing: they move a cursor.
 *
 * A `W` contributes NOTHING, and is the only acting op that does not. It used to be charged a
 * nominal 2s on the reasoning that it blocked for a quiescent window; it has no quiet window any
 * more — it waits for tokens, and with nothing outstanding it returns on its first poll and can
 * legitimately take no measurable time at all. Charging even one round-trip for it would be
 * charging for a property of the environment rather than of the history, and would turn `N1AaWW`
 * into a floor violation on any fast driver. A floor is a lower bound, not an expectation.
 */
export function historyDurationExpectedMinSec(h: History): number {
  let sec = 0;
  for (const op of h) {
    if (op.cmd === "pause") sec += op.seconds ?? DEFAULT_PAUSE_SEC;
    else if (op.cmd === "disconnect" || op.cmd === "connect" || op.cmd === "append") sec += OP_MIN_SEC;
  }
  return Number(sec.toFixed(3)); // 0.1 + 0.2 must not become 0.30000000000000004 in a log line
}
