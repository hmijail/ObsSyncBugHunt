// Core types shared across the harness.

export type NodeId = string;

/** Result of one Obsidian CLI invocation. Always recorded, even on failure. */
export interface ExecResult {
  argv: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: string; // ISO 8601
  durationMs: number;
  killed: boolean; // true if the process was killed by the timeout (untimely)
}

/** Structured outcome of a driver method. `raw` is kept for the audit trail. */
export interface OpResult<T = string> {
  ok: boolean;
  value?: T;
  error?: string;
  raw: ExecResult;
}

/**
 * A uniquely-identifiable edit. We embed `formatToken(...)` into note content so
 * the oracle can locate each acknowledged edit by exact string match in the
 * canonical file OR any "(Conflicted copy ...)" file. `seq` is a per-run
 * monotonic counter and note names are unique per history, so `<node>-<seq>-<note>`
 * is already unique — no UUID needed.
 *
 * The token is wrapped in parens — `(<node>-<seq>-<note>)` — so it is
 * **self-delimiting**: without the closing `)`, `n1-1-a` would be a substring of
 * `n1-10-a`, making the oracle miscount occurrences (false-positive duplication,
 * and masked loss). Parens (not brackets) because `[ ]` reads as a task checkbox and
 * `[[ ]]` as a wikilink in Obsidian's editor — they render awkwardly in the GUI —
 * whereas parens are inert plain text. The CLI stores/returns raw markdown, so the
 * token round-trips untouched.
 */
export interface EditToken {
  node: NodeId;
  seq: number;
  note: string; // logical note letter/name the edit was inserted into
}

export function formatToken(t: EditToken): string {
  return `(${t.node}-${t.seq}-${t.note})`;
}

/**
 * Folder all harness notes live under, so the tester only ever creates/reads/deletes
 * inside it — it can never disturb (or empty) a real, in-use vault. Cleanup is scoped
 * to this folder for the same reason.
 */
export const NOTE_DIR = "bughunt";

/** A server-side sync version, as listed by `diff filter=sync` (newest = 1). */
export interface SyncVersion {
  version: number;
  source: string; // e.g. "Sync"
  timestamp: string; // "YYYY-MM-DD HH:MM:SS"
  size: string; // e.g. "83 B"
  device: string; // e.g. "HMMBP.local"
}

/** A local (File recovery) version, as listed by `history`. */
export interface FileVersion {
  version: number;
  timestamp: string; // "YYYY-MM-DD HH:MM"
  size: string;
}

/** One acknowledged operation, appended to the run's JSONL history. */
export interface HistoryEntry {
  ts: string;
  node: NodeId;
  verb: string;
  note?: string;
  token?: string;
  ok: boolean;
  code: number | null;
  argv: string[];
  stdoutPreview: string;
}
