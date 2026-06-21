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
}

export interface RunVerdict {
  ok: boolean;
  notes: NoteVerdict[];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    count++;
  }
  return count;
}

function sameConflictSet(a: ConflictFile[], b: ConflictFile[]): boolean {
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

  // onlyInConflict is acceptable (that's the conflict-file mode working);
  // lost / duplicated / divergence are failures.
  const ok = lost.length === 0 && duplicated.length === 0 && converged;
  return { note, ok, converged, lost, onlyInConflict, duplicated, perNodeMissing };
}

export function checkRun(acked: AckedEdit[], observations: NodeObservation[]): RunVerdict {
  const notes = [...new Set(acked.map((a) => a.note))];
  const verdicts = notes.map((n) => checkNote(n, acked, observations));
  return { ok: verdicts.every((v) => v.ok), notes: verdicts };
}
