// Thin wrapper over the Obsidian CLI: `obsidian <command> key=value ...`.
//
// Every mutation goes through Obsidian (never a direct file write) so the app's
// own Sync engine is engaged exactly as it would be for a human edit.
//
// Output-parsing note: the exact stdout formats of `files`, `diff`, and
// `history` are confirmed empirically via `npm run smoke` before we build
// parsers on top of them. Until then these return raw trimmed text.

import type { Executor } from "./exec.js";
import type { ExecResult, FileVersion, OpResult, SyncVersion } from "./types.js";

export class ObsidianDriver {
  constructor(private readonly executor: Executor) {}

  get node() {
    return this.executor.id;
  }

  // Each node runs exactly one vault, so we never pass vault=. File commands
  // would accept it, but sync:* commands ignore it (e.g. `sync:status
  // vault=X` still reports the active remote vault) — so it's pure noise.
  private run(command: string, params: string[] = []): Promise<ExecResult> {
    return this.executor.exec([command, ...params]);
  }

  private wrap(raw: ExecResult): OpResult {
    return raw.code === 0
      ? { ok: true, value: raw.stdout.trim(), raw }
      : { ok: false, error: (raw.stderr || raw.stdout).trim(), raw };
  }

  // --- note mutations -------------------------------------------------------

  async createNote(name: string, content = ""): Promise<OpResult> {
    const p = [`name=${name}`];
    if (content) p.push(`content=${content}`);
    return this.wrap(await this.run("create", p));
  }

  /** Appends `line` plus a trailing newline (omit `inline` => newline added). */
  async appendLine(name: string, line: string): Promise<OpResult> {
    return this.wrap(await this.run("append", [`file=${name}`, `content=${line}`]));
  }

  /** Prepends `line` to the top of the note (CLI `prepend`) — edits the other end. */
  async prependLine(name: string, line: string): Promise<OpResult> {
    return this.wrap(await this.run("prepend", [`file=${name}`, `content=${line}`]));
  }

  async read(name: string): Promise<OpResult> {
    return this.wrap(await this.run("read", [`file=${name}`]));
  }

  /** Read by exact vault-relative path (needed for "(Conflicted copy …)" files). */
  async readByPath(path: string): Promise<OpResult> {
    return this.wrap(await this.run("read", [`path=${path}`]));
  }

  /**
   * Whether a note exists locally on this node. `read` exits 0 even when absent
   * (printing `Error: File "X" not found.`), so we key on the content: present =
   * non-empty, non-error; absent = empty or that error string.
   */
  async exists(name: string): Promise<boolean> {
    const r = await this.read(name);
    const v = (r.value ?? "").trim();
    return r.ok && v !== "" && !v.startsWith("Error:");
  }

  async deleteNote(name: string, permanent = false): Promise<OpResult> {
    const p = [`file=${name}`];
    if (permanent) p.push("permanent");
    return this.wrap(await this.run("delete", p));
  }

  // --- introspection / oracle inputs ---------------------------------------
  // Parsers below are based on observed CLI output (see src/smoke.ts). They
  // keep the raw ExecResult so anything unparsed is still recoverable.

  /** Vault file names, one per line. */
  async listFiles(folder?: string): Promise<OpResult<string[]>> {
    const raw = await this.run("files", folder ? [`folder=${folder}`] : []);
    if (raw.code !== 0) return { ok: false, error: errText(raw), raw };
    return { ok: true, value: parseLines(raw.stdout), raw };
  }

  /** Just the "(Conflicted copy …)" files in the vault. */
  async listConflictFiles(): Promise<OpResult<string[]>> {
    const r = await this.listFiles();
    if (!r.ok) return r;
    return { ...r, value: (r.value ?? []).filter(isConflictFile) };
  }

  /** Obsidian's own view: list server-side sync versions (newest = 1). */
  async diffSync(name: string): Promise<OpResult<SyncVersion[]>> {
    const raw = await this.run("diff", [`file=${name}`, "filter=sync"]);
    if (raw.code !== 0) return { ok: false, error: errText(raw), raw };
    return { ok: true, value: parseSyncVersions(raw.stdout), raw };
  }

  /** Local (File recovery) version list. */
  async history(name: string): Promise<OpResult<FileVersion[]>> {
    const raw = await this.run("history", [`file=${name}`]);
    if (raw.code !== 0) return { ok: false, error: errText(raw), raw };
    return { ok: true, value: parseFileVersions(raw.stdout), raw };
  }

  // --- Sync control & introspection (require a Sync-linked vault) -----------

  /** Obsidian's purpose-built pause — gentler than toggling the core plugin. */
  async syncPause(): Promise<OpResult> {
    return this.wrap(await this.run("sync", ["off"]));
  }

  async syncResume(): Promise<OpResult> {
    return this.wrap(await this.run("sync", ["on"]));
  }

  /** Authoritative sync state (reports the active vault). */
  async syncStatus(): Promise<OpResult> {
    return this.wrap(await this.run("sync:status"));
  }

  /** Server-side sync version list for a note (raw until format confirmed). */
  async syncHistory(name: string): Promise<OpResult> {
    return this.wrap(await this.run("sync:history", [`file=${name}`]));
  }

  /**
   * Cumulative count of server-side sync versions for a note (`sync:history total`).
   * Monotonic and server-side (all nodes agree), so its delta over time is a
   * level signal for "a sync happened" that polling can't alias.
   */
  async syncVersionsTotal(name: string): Promise<OpResult<number>> {
    const raw = await this.run("sync:history", [`file=${name}`, "total"]);
    if (raw.code !== 0) return { ok: false, error: errText(raw), raw };
    const n = Number(raw.stdout.trim());
    return Number.isFinite(n)
      ? { ok: true, value: n, raw }
      : { ok: false, error: `unparseable total: ${JSON.stringify(raw.stdout.trim())}`, raw };
  }

  /** Read the content of a specific server-side sync version. */
  async syncRead(name: string, version: number): Promise<OpResult> {
    return this.wrap(await this.run("sync:read", [`file=${name}`, `version=${version}`]));
  }

  // --- fault primitive (alternative) ----------------------------------------
  // Toggling the sync *core plugin*; kept for comparison vs sync pause / network
  // disconnect when we measure reconnection noise.

  async setSyncPlugin(enabled: boolean): Promise<OpResult> {
    const cmd = enabled ? "plugin:enable" : "plugin:disable";
    return this.wrap(await this.run(cmd, ["id=sync", "filter=core"]));
  }
}

// --- output parsers (verified against real CLI output; see src/smoke.ts) -----

function errText(raw: ExecResult): string {
  return (raw.stderr || raw.stdout).trim();
}

function parseLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

export function isConflictFile(name: string): boolean {
  // e.g. "Meeting notes (Conflicted copy MyMacBook2 202411281430).md"
  return /\(Conflicted copy .+\)\.md$/.test(name);
}

// `diff filter=sync` rows: "<ver>  Sync  <YYYY-MM-DD HH:MM:SS>  <size>  [<device>]"
const SYNC_ROW =
  /^(\d+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?)\s+\[([^\]]+)\]\s*$/;

function parseSyncVersions(stdout: string): SyncVersion[] {
  const out: SyncVersion[] = [];
  for (const line of stdout.split("\n")) {
    const m = SYNC_ROW.exec(line);
    if (m)
      out.push({
        version: Number(m[1]),
        source: m[2],
        timestamp: m[3],
        size: m[4].trim(),
        device: m[5],
      });
  }
  return out;
}

// `history` rows: "<ver>  <YYYY-MM-DD HH:MM>  <size>"
const HISTORY_ROW = /^(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+?)\s*$/;

function parseFileVersions(stdout: string): FileVersion[] {
  const out: FileVersion[] = [];
  for (const line of stdout.split("\n")) {
    const m = HISTORY_ROW.exec(line);
    if (m) out.push({ version: Number(m[1]), timestamp: m[2], size: m[3].trim() });
  }
  return out;
}
