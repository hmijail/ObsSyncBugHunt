// History DSL: a history is a string of user actions, e.g. "N1DAaC".
//
// COMMANDS are uppercase, params are lowercase letters / digits. The active node is a
// cursor that persists until changed (N). Each append names its own note, so a history
// reads as what the USER does — the user never "syncs", they only Wait and hope it happens.
//
//   N<d>   set active node           (N1, N2)
//   A<x>   append a line to note <x> by the active node (first touch of a note creates it)
//   D      disconnect the active node (network)
//   C      connect the active node
//   W      wait until the active node is synced & settled
//   P[<n>] pause ~n seconds (default 10)
//
// Every history (generated or typed) is run through `normalize` first, so the printed
// string is exactly what executes (see normalize). Trailing waits are implicit (the
// executor always settles before judging); timing is otherwise string-controlled.

export type Cmd = "node" | "append" | "disconnect" | "connect" | "wait" | "pause";

export interface Op {
  cmd: Cmd;
  node?: number; // "node": 1-based node index
  note?: string; // "append": note letter
  seconds?: number; // "pause": seconds
}

export type History = Op[];

export const DEFAULT_PAUSE_SEC = 10;

// The ops a pause is "noticeable" next to (and the ones a node-set exists to serve).
const ACTIONS = new Set<Cmd>(["disconnect", "connect", "append"]);
const isAction = (op: Op | undefined) => op != null && ACTIONS.has(op.cmd);

/** Parse a history string into ops. Whitespace is ignored (for readability). */
export function parse(s: string): History {
  const t = s.replace(/\s+/g, "");
  const ops: History = [];
  let i = 0;
  const digits = () => {
    let n = "";
    while (i < t.length && t[i] >= "0" && t[i] <= "9") n += t[i++];
    return n;
  };
  while (i < t.length) {
    const ch = t[i++];
    switch (ch) {
      case "N": {
        const n = digits();
        if (!n) throw new Error(`'N' needs a node number (at index ${i - 1} of "${s}")`);
        ops.push({ cmd: "node", node: Number(n) });
        break;
      }
      case "A": {
        const note = t[i];
        if (!note || note < "a" || note > "z") throw new Error(`'A' needs a note letter (at index ${i} of "${s}")`);
        i++;
        ops.push({ cmd: "append", note });
        break;
      }
      case "D": ops.push({ cmd: "disconnect" }); break;
      case "C": ops.push({ cmd: "connect" }); break;
      case "W": ops.push({ cmd: "wait" }); break;
      case "P": {
        const n = digits();
        ops.push({ cmd: "pause", seconds: n ? Number(n) : DEFAULT_PAUSE_SEC });
        break;
      }
      default:
        throw new Error(`unexpected '${ch}' (at index ${i - 1} of "${s}")`);
    }
  }
  return ops;
}

/** Serialize ops back to the canonical string (round-trips with parse). */
export function serialize(h: History): string {
  return h
    .map((op) => {
      switch (op.cmd) {
        case "node": return `N${op.node}`;
        case "append": return `A${op.note}`;
        case "disconnect": return "D";
        case "connect": return "C";
        case "wait": return "W";
        case "pause": return op.seconds === DEFAULT_PAUSE_SEC ? "P" : `P${op.seconds}`;
      }
    })
    .join("");
}

// --- normalization: printed == executed --------------------------------------
//
// `normalize` is the single canonical preprocessing applied to EVERY history (generated or
// typed). Three passes, in order:
//   1. floatPauses        — a pause only matters next to an action (D/C/A). One sandwiched
//                           between non-actions is moved to just before the next action (or
//                           dropped if there is none); carried pauses sum.
//   2. dropRedundantNodes — an N overwritten before use, or re-selecting the active node, goes.
//   3. collapseAdjacent   — dedup adjacent A(same note)/D/C/W; sum adjacent pauses.

/** Move "floating" pauses (not adjacent to an action) forward to the next action. */
function floatPauses(h: History): History {
  const out: History = [];
  let carried = 0; // accumulated seconds of floated pauses awaiting the next action
  for (let i = 0; i < h.length; i++) {
    const op = h[i];
    if (op.cmd === "pause") {
      const prev = out[out.length - 1];
      const next = h[i + 1];
      if (isAction(prev) || isAction(next)) {
        out.push({ ...op }); // anchored: a pause just after/before an action stays put
      } else {
        carried += op.seconds ?? DEFAULT_PAUSE_SEC; // floating: defer to the next action
      }
      continue;
    }
    if (carried > 0 && isAction(op)) {
      out.push({ cmd: "pause", seconds: carried });
      carried = 0;
    }
    out.push({ ...op });
  }
  // carried with no following action → dropped
  return out;
}

/** Drop node-sets that are never used: re-selecting the active node, or overwritten by the
 *  next node-set before any node-using op (anything but a pause). */
function dropRedundantNodes(h: History): History {
  const out: History = [];
  let active = 0;
  for (let i = 0; i < h.length; i++) {
    const op = h[i];
    if (op.cmd !== "node") { out.push({ ...op }); continue; }
    if (op.node === active) continue; // no-op re-select
    let j = i + 1;
    while (j < h.length && h[j].cmd === "pause") j++; // a pause doesn't "use" the node
    if (j >= h.length || h[j].cmd === "node") continue; // nothing uses it / overwritten
    active = op.node!;
    out.push({ ...op });
  }
  return out;
}

/** Collapse adjacent redundancy: a duplicate of A (same note)/D/C/W is dropped, and
 *  consecutive pauses are summed. */
function collapseAdjacent(h: History): History {
  const out: History = [];
  for (const op of h) {
    const prev = out[out.length - 1];
    if (prev && prev.cmd === op.cmd) {
      if (op.cmd === "pause") {
        prev.seconds = (prev.seconds ?? DEFAULT_PAUSE_SEC) + (op.seconds ?? DEFAULT_PAUSE_SEC);
        continue;
      }
      if (op.cmd === "append" && prev.note === op.note) continue; // back-to-back same-note edit
      if (op.cmd === "disconnect" || op.cmd === "connect" || op.cmd === "wait") continue;
    }
    out.push({ ...op });
  }
  return out;
}

/** Canonicalize a history so the printed/serialized form is exactly what executes. */
export function normalize(h: History): History {
  return collapseAdjacent(dropRedundantNodes(floatPauses(h)));
}
