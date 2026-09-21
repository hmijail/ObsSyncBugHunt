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

/**
 * The host's own Obsidian CLI, for the local node (`L`) and the local-only entry points
 * (smoke.ts, run-local.ts). A BARE COMMAND NAME, resolved on PATH — matching the Makefile's
 * `LOCAL_BIN ?= obsidian`, which is the same decision spelled once for make and once for the
 * TypeScript that make invokes.
 *
 * Two things this is deliberately NOT:
 *
 *  - Not an absolute path. Two entry points used to default to a literal
 *    `/Users/<the author>/Applications/Obsidian.app/...`, which is broken on every machine but
 *    one. src/repro.ts already carries a comment warning against exactly that; the rule existed,
 *    it just wasn't applied here.
 *  - Not the GUI binary. Inside Obsidian.app there are two executables, `Obsidian` (Electron) and
 *    `obsidian-cli`. Both dispatch CLI subcommands, so the difference only shows when the app is
 *    UNREACHABLE: `obsidian-cli` exits 1 immediately with "The CLI is unable to find Obsidian",
 *    while the GUI binary BLOCKS — riding out runProcess's 120s cap and producing nothing at all.
 *    A harness whose failure mode is a silent two-minute stall is a harness nobody debugs. The
 *    normal install/activation flow puts `obsidian` (the CLI) on PATH on both macOS and Linux.
 *
 * Override with `--bin` (or make's `LOCAL_BIN=`) if it isn't on PATH.
 */
export const DEFAULT_LOCAL_BIN = "obsidian";

/** A server-side sync version, as listed by `diff filter=sync` (newest = 1). */
export interface SyncVersion {
  version: number;
  source: string; // e.g. "Sync"
  timestamp: string; // "YYYY-MM-DD HH:MM:SS"
  size: string; // e.g. "83 B"
  device: string; // e.g. "HMMBP.local"
}

/**
 * One entry of `sync:history file=<n>`, the note's SERVER-side version list.
 *
 * Distinct from `SyncVersion` (which is `diff filter=sync`) and from `FileVersion` (local File
 * recovery); all three list versions, in three different formats.
 *
 * `uploadedAt` is epoch ms, parsed as UTC — the container reports UTC while the host may not, and
 * an hour's error here would read as a plausible stale reading rather than as a bug.
 */
export interface SyncHistoryVersion {
  version: number;      // 0 is newest
  uploadedAt: number;   // epoch ms, from a UTC "YYYY-MM-DD HH:MM:SS" with NO sub-second field
  bytes: number;
  device: string;       // the node that produced this version, e.g. "n1"
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
