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
 * monotonic counter and note names are unique per history, so `op-<node>-<seq>`
 * is already unique — no UUID needed.
 */
export interface EditToken {
  node: NodeId;
  seq: number;
}

export function formatToken(t: EditToken): string {
  return `op-${t.node}-${t.seq}`;
}

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
