// The convergence / data-loss oracle.
//
// Pure logic: given the edits we *acknowledged* and what each node *observes*
// after sync settles, decide whether anything was lost, duplicated, or failed
// to converge. No Obsidian dependency, so it is unit-testable in isolation.
//
// Each edit carries a globally-unique token (see types.formatToken), so
// "did this edit survive?" is an exact substring search across a node's
// canonical note content and any "(Conflicted copy …)" files.

import type { NodeId } from "./types.js";

/** An append we received an :ok for — ground truth of "what was acknowledged". */
export interface AckedEdit {
  note: string;
  node: NodeId;
  token: string;
}

export interface ConflictFile {
  file: string;
  content: string;
}

/** What one node sees for one note after convergence. */
export interface NodeObservation {
  node: NodeId;
  note: string;
  canonical: string | null; // null => the note is absent on this node
  conflicts: ConflictFile[];
}

export interface NoteVerdict {
  note: string;
  ok: boolean;
  converged: boolean; // all nodes agree on canonical content AND conflict set
  lost: string[]; // acknowledged tokens present nowhere => DATA LOSS
  onlyInConflict: string[]; // preserved only via a conflict file (OK in that mode)
  duplicated: { token: string; maxCount: number }[]; // a token repeated in one file
  perNodeMissing: { node: NodeId; missing: string[] }[]; // tokens absent from a node
  conflictFiles: number; // max conflict-file count on any node (storm indicator; informational)
  // Per conflict file: the device named in `(Conflicted copy <device> <ts>)`, whether
  // that name is well-formed (device is a known node), and which nodes hold it.
  // Informational — the token oracle stays the correctness gate (auto-merge is legal).
  conflictMeta: { file: string; device: string | null; wellFormed: boolean; holders: NodeId[] }[];
}

export interface RunVerdict {
  ok: boolean;
  notes: NoteVerdict[];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    // Boundary guard: don't count a token that is only a prefix of a longer one
    // (e.g. `op-n1-1` inside `op-n1-10`). Tokens are parenthesized (`(op-…)`) so the
    // trailing `)` already delimits them, but this keeps the count correct even if
    // the token format ever regresses to a bare, digit-terminated form.
    const after = haystack[i + needle.length];
    if (after === undefined || after < "0" || after > "9") count++;
  }
  return count;
}

export function sameConflictSet(a: ConflictFile[], b: ConflictFile[]): boolean {
  if (a.length !== b.length) return false;
  // JSON-encode the (file, content) pair: unambiguous and text-safe.
  const key = (c: ConflictFile) => JSON.stringify([c.file, c.content]);
  const sa = new Set(a.map(key));
  return b.every((c) => sa.has(key(c)));
}

export function checkNote(
  note: string,
  acked: AckedEdit[],
  observations: NodeObservation[],
): NoteVerdict {
  const tokens = [...new Set(acked.filter((a) => a.note === note).map((a) => a.token))];
  const obs = observations.filter((o) => o.note === note);

  const lost: string[] = [];
  const onlyInConflict: string[] = [];
  const duplicated: { token: string; maxCount: number }[] = [];

  for (const token of tokens) {
    let inCanonical = false;
    let anywhere = false;
    let maxCount = 0;
    for (const o of obs) {
      const texts = [o.canonical ?? "", ...o.conflicts.map((c) => c.content)];
      for (const t of texts) {
        const n = occurrences(t, token);
        if (n > 0) anywhere = true;
        if (n > maxCount) maxCount = n;
      }
      if (o.canonical && occurrences(o.canonical, token) > 0) inCanonical = true;
    }
    if (!anywhere) lost.push(token);
    else if (!inCanonical) onlyInConflict.push(token);
    if (maxCount > 1) duplicated.push({ token, maxCount });
  }

  const perNodeMissing = obs.map((o) => {
    const texts = [o.canonical ?? "", ...o.conflicts.map((c) => c.content)];
    return { node: o.node, missing: tokens.filter((tk) => !texts.some((t) => t.includes(tk))) };
  });

  let converged = true;
  if (obs.length > 1) {
    const first = obs[0];
    for (const o of obs.slice(1)) {
      if ((o.canonical ?? null) !== (first.canonical ?? null)) converged = false;
      if (!sameConflictSet(o.conflicts, first.conflicts)) converged = false;
    }
  }

  // Conflict-file count (max across nodes) — a "stale device floods conflicts"
  // storm shows up as an unexpectedly large number here. Informational: doesn't
  // affect ok (an "expected" count is too fuzzy to gate on), but always recorded.
  const conflictFiles = obs.reduce((m, o) => Math.max(m, o.conflicts.length), 0);

  // Per conflict file: parse the device named in `(Conflicted copy <device> <ts>)`,
  // check it's a known node (Obsidian names the file after the device that produced
  // it — the local/losing side), and record which nodes hold the file.
  const validDevices = new Set(obs.map((o) => o.node));
  const cfMap = new Map<string, { device: string | null; wellFormed: boolean; holders: NodeId[] }>();
  for (const o of obs) {
    for (const c of o.conflicts) {
      const m = /\(Conflicted copy (.+) (\d{12})\)\.md$/.exec(c.file);
      const device = m ? m[1] : null;
      const entry = cfMap.get(c.file) ?? { device, wellFormed: m != null && validDevices.has(device!), holders: [] };
      if (!entry.holders.includes(o.node)) entry.holders.push(o.node);
      cfMap.set(c.file, entry);
    }
  }
  const conflictMeta = [...cfMap.entries()].map(([file, v]) => ({ file, ...v }));

  // onlyInConflict is acceptable (that's the conflict-file mode working);
  // lost / duplicated / divergence are failures.
  const ok = lost.length === 0 && duplicated.length === 0 && converged;
  return { note, ok, converged, lost, onlyInConflict, duplicated, perNodeMissing, conflictFiles, conflictMeta };
}

export function checkRun(acked: AckedEdit[], observations: NodeObservation[]): RunVerdict {
  const notes = [...new Set(acked.map((a) => a.note))];
  const verdicts = notes.map((n) => checkNote(n, acked, observations));
  return { ok: verdicts.every((v) => v.ok), notes: verdicts };
}
