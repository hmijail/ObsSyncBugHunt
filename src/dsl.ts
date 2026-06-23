// History DSL: a history is a string of user actions, e.g. "N1DEaAC".
//
// COMMANDS are uppercase, params are lowercase letters / digits. The active node
// and active note are cursors that persist until changed. A history reads as what
// the USER does — the user never "syncs", they only Wait and hope it happens.
//
//   N<d>  set active node          (N1, N2)
//   E<x>  select active note        (Ea)   — first touch of a note creates it
//   A     append a line to the active note by the active node
//   D     disconnect the active node (network)
//   C     connect the active node
//   W     wait until the active node is synced & settled
//   P[<n>] pause ~n seconds (default 10)
//
// Trailing waits are implicit (the executor always settles before judging), and
// timing is otherwise string-controlled: ops run back-to-back unless W/P say wait.

export type Cmd = "node" | "select" | "append" | "disconnect" | "connect" | "wait" | "pause";

export interface Op {
  cmd: Cmd;
  node?: number; // "node": 1-based node index
  note?: string; // "select": note letter
  seconds?: number; // "pause": seconds
}

export type History = Op[];

const DEFAULT_PAUSE = 10;

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
      case "E": {
        const note = t[i];
        if (!note || note < "a" || note > "z") throw new Error(`'E' needs a note letter (at index ${i} of "${s}")`);
        i++;
        ops.push({ cmd: "select", note });
        break;
      }
      case "A": ops.push({ cmd: "append" }); break;
      case "D": ops.push({ cmd: "disconnect" }); break;
      case "C": ops.push({ cmd: "connect" }); break;
      case "W": ops.push({ cmd: "wait" }); break;
      case "P": {
        const n = digits();
        ops.push({ cmd: "pause", seconds: n ? Number(n) : DEFAULT_PAUSE });
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
        case "select": return `E${op.note}`;
        case "append": return "A";
        case "disconnect": return "D";
        case "connect": return "C";
        case "wait": return "W";
        case "pause": return op.seconds === DEFAULT_PAUSE ? "P" : `P${op.seconds}`;
      }
    })
    .join("");
}
