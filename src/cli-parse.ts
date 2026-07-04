// Paranoid recognizers for obsidian-cli output. See docs/cli-trust.md.
//
// Each recognizer returns a typed result ONLY for output it can POSITIVELY identify as a
// valid answer to the exact question asked (a known success shape, or the canonical
// "absent" form). Anything else — empty where unexpected, an unknown `Error:`, junk, or a
// shape we don't model — returns the UNRECOGNIZED sentinel. The driver turns UNRECOGNIZED
// into a fatal CliUnrecognizedOutput → flagged inconsistency/abort, so a future obsidian-cli format change
// halts loudly instead of silently mis-scoring. "Looks like it isn't an error" is NOT
// enough; the output must affirmatively match a known answer.

import type { ExecResult, SyncVersion, FileVersion } from "./types.js";

export const UNRECOGNIZED = Symbol("unrecognized-cli-output");
export type Unrecognized = typeof UNRECOGNIZED;

/** Thrown when obsidian-cli output can't be positively identified; ends the rep `-UNKNOWN`.
 *  `recognizer` names the (small) parse function that failed — the one to teach the new shape. */
export class CliUnrecognizedOutput extends Error {
  constructor(readonly raw: ExecResult, readonly recognizer?: string) {
    super(
      `unrecognized obsidian-cli output${recognizer ? ` (recognizer: ${recognizer})` : ""} for ` +
        `[${raw.argv.join(" ")}]: ${JSON.stringify(raw.stdout)}`,
    );
    this.name = "CliUnrecognizedOutput";
  }
}

// The single canonical "this file does not exist" form — shared by read/sync:history/diff.
const NOT_FOUND = /^Error: File ".*" not found\.$/;
export function isNotFoundError(stdout: string): boolean {
  return NOT_FOUND.test(stdout.trim());
}

// --- read --------------------------------------------------------------------
// content present, or positively absent (the not-found form). Empty or any other
// `Error:` is unrecognized (our notes always carry a token, so empty == a failed call).
export type ReadResult = { present: true; content: string } | { present: false };
export function parseRead(stdout: string): ReadResult | Unrecognized {
  const t = stdout.trim();
  if (t === "") return UNRECOGNIZED;
  if (isNotFoundError(t)) return { present: false };
  if (t.startsWith("Error:")) return UNRECOGNIZED; // some other error we don't model
  return { present: true, content: t };
}

// --- files [folder=] ---------------------------------------------------------
// Zero or more vault-relative paths. Any `Error:` line is unrecognized. NB an empty list
// is returned as [] but is NOT by itself a positive "empty folder" — see docs/cli-trust.md;
// the caller must confirm emptiness independently (anchor against known notes, or FS).
export function parseFilesList(stdout: string): string[] | Unrecognized {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (const l of lines) if (l.startsWith("Error:")) return UNRECOGNIZED;
  return lines;
}

// --- sync:status -------------------------------------------------------------
// Must carry a `status: <word>` whose value we recognize. An unseen status word is
// unrecognized → fatal, forcing us to learn (and handle) it rather than guess.
export const KNOWN_SYNC_STATUS = new Set(["synced", "syncing", "paused", "error", "stopped", "offline"]);
export function parseSyncStatus(stdout: string): { status: string } | Unrecognized {
  const m = /^status:\s*(\S+)/m.exec(stdout);
  if (!m) return UNRECOGNIZED;
  if (!KNOWN_SYNC_STATUS.has(m[1])) return UNRECOGNIZED;
  return { status: m[1] };
}

// --- sync:history file= total ------------------------------------------------
// A bare non-negative integer, or positively absent.
export function parseTotal(stdout: string): number | "absent" | Unrecognized {
  const t = stdout.trim();
  if (isNotFoundError(t)) return "absent";
  if (/^\d+$/.test(t)) return Number(t);
  return UNRECOGNIZED;
}

// --- sync:history file= (raw listing) ----------------------------------------
// The non-empty server-side listing text, or positively absent. Empty / other `Error:`
// (e.g. `Error: Sync is in error state.` while disconnected) is unrecognized → retried.
export function parseSyncHistory(stdout: string): string | "absent" | Unrecognized {
  const t = stdout.trim();
  if (isNotFoundError(t)) return "absent";
  if (t === "" || t.startsWith("Error:")) return UNRECOGNIZED;
  return t;
}

// --- sync:read file= version= ------------------------------------------------
// Header `<name> (version N, <date>)` then `---` then content; or a known "no such
// version" error; or positively absent (file not found).
export type SyncReadResult = { kind: "content"; content: string } | { kind: "no-version" } | { kind: "absent" };
const SYNC_READ_HEADER = /^.+\(version \d+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\)\n---\n/;
const NO_VERSION = /^Error: Failed to retrieve version:/;
export function parseSyncRead(stdout: string): SyncReadResult | Unrecognized {
  const t = stdout.trim();
  if (isNotFoundError(t)) return { kind: "absent" };
  if (NO_VERSION.test(t)) return { kind: "no-version" };
  const m = SYNC_READ_HEADER.exec(stdout);
  if (m) return { kind: "content", content: stdout.slice(m[0].length).trim() };
  return UNRECOGNIZED;
}

// --- diff file= filter=sync --------------------------------------------------
// Filename header line, then rows: "<ver>  Sync  <YYYY-MM-DD HH:MM:SS>  <size>  [<device>]".
const SYNC_ROW = /^(\d+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?)\s+\[([^\]]+)\]\s*$/;
export function parseSyncVersions(stdout: string): SyncVersion[] | "absent" | Unrecognized {
  const t = stdout.trim();
  if (t === "") return UNRECOGNIZED;
  if (isNotFoundError(t)) return "absent";
  const out: SyncVersion[] = [];
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const m = SYNC_ROW.exec(line);
    if (m) out.push({ version: Number(m[1]), source: m[2], timestamp: m[3], size: m[4].trim(), device: m[5] });
    else if (line.startsWith("Error:")) return UNRECOGNIZED;
    // else: the filename header line — ignored.
  }
  return out;
}

// --- history file= -----------------------------------------------------------
// Rows: "<ver>  <YYYY-MM-DD HH:MM>  <size>"; or positively absent.
const HISTORY_ROW = /^(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+?)\s*$/;
export function parseFileVersions(stdout: string): FileVersion[] | "absent" | Unrecognized {
  const t = stdout.trim();
  if (isNotFoundError(t)) return "absent";
  const out: FileVersion[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const m = HISTORY_ROW.exec(line);
    if (m) out.push({ version: Number(m[1]), timestamp: m[2], size: m[3].trim() });
    else if (line.startsWith("Error:")) return UNRECOGNIZED;
  }
  return out;
}

// --- mutations (create/append/prepend/open/delete) ---------------------------
// Each prints a known success line. Anything else is unrecognized. (Correctness is still
// judged by reading the token back, never by this message — but the message must parse.)
const MUTATION_OK = /^(Created|Appended to|Prepended to|Opened|Deleted|Deleted permanently|Moved to trash|Trashed): /;
export function parseMutation(stdout: string): "ok" | Unrecognized {
  return MUTATION_OK.test(stdout.trim()) ? "ok" : UNRECOGNIZED;
}
