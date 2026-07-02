// Thin, PARANOID wrapper over the Obsidian CLI: `obsidian <command> key=value ...`.
//
// Every mutation goes through Obsidian (never a direct file write) so the app's own Sync
// engine is engaged exactly as it would be for a human edit.
//
// Trust model (see docs/cli-trust.md): the CLI always exits 0 and can return empty/garbage
// when the app or podman is unresponsive, so we NEVER take output at face value. Each call:
//   1. is bounded by a HARD timeout; if killed (untimely) we log `cli-unresponsive` and RETRY
//      (wait for recovery) — we never judge on a stalled read.
//   2. once timely, its output must be POSITIVELY identified by a recognizer (see cli-parse.ts);
//      anything unrecognized throws CliUnrecognizedOutput, which the run turns into a loud ALARM
//      and abort (so a future obsidian-cli format change fails loudly, not silently).

import assert from "node:assert/strict";
import type { Executor } from "./exec.js";
import type { ExecResult, FileVersion, OpResult, SyncVersion } from "./types.js";
import {
  CliUnrecognizedOutput, UNRECOGNIZED, type Unrecognized,
  parseRead, parseFilesList, parseSyncStatus, parseTotal, parseSyncRead,
  parseSyncVersions, parseFileVersions, parseMutation, parseSyncHistory, isNotFoundError,
} from "./cli-parse.js";
import { AlarmError } from "./alarm.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait-for-recovery bounds for an unresponsive CLI: retry every BACKOFF up to MAX_RETRIES
// (~10 min), then it's a permanent outage → ALARM.
const UNRESPONSIVE_BACKOFF_MS = 5_000;
const UNRESPONSIVE_MAX_RETRIES = 120;

// Wait-for-recovery bounds for a read whose output isn't (yet) parseable — typically a node
// mid-(re)connect reporting `Error: Sync is in error state.` on a sync command. Retry every
// BACKOFF up to MAX_RETRIES hoping the reply becomes recognizable; kept short relative to the
// settle cap (~120s) so one read can't dominate a settle. Then the rep ends `-UNKNOWN`.
const RECOGNIZE_BACKOFF_MS = 2_000;
const RECOGNIZE_MAX_RETRIES = 15;

export class ObsidianDriver {
  /** Optional per-rep sink for cli-unresponsive events (set to RunLogger.log); else console. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Backoff between recognize-retries; overridable so tests don't wait real seconds. */
  recognizeBackoffMs = RECOGNIZE_BACKOFF_MS;

  // `vaultPath` (the vault's on-disk root, e.g. /root/vaults/TestVault) enables the
  // filesystem second-source. Unset (local/dev) → FS cross-checks are skipped.
  constructor(private readonly executor: Executor, private readonly vaultPath?: string) {}

  get node() {
    return this.executor.id;
  }

  private emit(event: Record<string, unknown>): void {
    if (this.onEvent) this.onEvent(event);
    else console.warn(`· ${JSON.stringify(event)}`);
  }

  // Each node runs exactly one vault, so we never pass vault=. File commands would accept
  // it, but sync:* commands ignore it — so it's pure noise.
  //
  // Runs the command with a hard timeout; on an untimely (killed) result, waits and retries
  // until the CLI responds. Returns only a TIMELY ExecResult (never a killed one).
  private async run(command: string, params: string[] = []): Promise<ExecResult> {
    for (let attempt = 1; ; attempt++) {
      const raw = await this.executor.exec([command, ...params]);
      if (!raw.killed) return raw;
      this.emit({ kind: "cli-unresponsive", node: this.node, command, attempt, durationMs: raw.durationMs });
      if (attempt >= UNRESPONSIVE_MAX_RETRIES) {
        throw new AlarmError("cli-permanently-unresponsive", { node: this.node, command, attempts: attempt });
      }
      await sleep(UNRESPONSIVE_BACKOFF_MS);
    }
  }

  /** Apply a recognizer to a raw result; UNRECOGNIZED throws (→ `-UNKNOWN`), naming the
   *  recognizer so the log points at the function to teach. Fail-fast — used for mutations
   *  (never retried, since re-issuing a write could double-apply it). */
  private expect<T>(raw: ExecResult, recognize: (stdout: string) => T | Unrecognized): T {
    const result = recognize(raw.stdout);
    if (result === UNRECOGNIZED) throw new CliUnrecognizedOutput(raw, recognize.name);
    return result;
  }

  /**
   * Read-only call with retry-for-recovery: run the command and apply `recognize`; if the
   * output isn't (yet) parseable — e.g. a node mid-(re)connect answering a sync command with
   * `Error: Sync is in error state.` — wait and re-run, hoping for a recognizable reply.
   * After RECOGNIZE_MAX_RETRIES it gives up and throws CliUnrecognizedOutput (→ `-UNKNOWN`),
   * naming the recognizer. SAFE only for idempotent reads — never use for a mutation.
   */
  private async runRecognized<T>(
    command: string,
    params: string[],
    recognize: (stdout: string) => T | Unrecognized,
  ): Promise<{ value: T; raw: ExecResult }> {
    for (let attempt = 0; ; attempt++) {
      const raw = await this.run(command, params); // run() still handles the untimely(killed) retry
      const result = recognize(raw.stdout);
      if (result !== UNRECOGNIZED) return { value: result, raw };
      if (attempt >= RECOGNIZE_MAX_RETRIES) throw new CliUnrecognizedOutput(raw, recognize.name);
      this.emit({
        kind: "cli-output-unrecognized-retry",
        node: this.node, command, recognizer: recognize.name, attempt: attempt + 1, stdout: raw.stdout,
      });
      await sleep(this.recognizeBackoffMs);
    }
  }

  /** Like `run`, but for a raw node-shell command (FS second-source); same untimely-retry. */
  private async runShell(argv: string[]): Promise<ExecResult> {
    for (let attempt = 1; ; attempt++) {
      const raw = await this.executor.shell(argv);
      if (!raw.killed) return raw;
      this.emit({ kind: "cli-unresponsive", node: this.node, command: argv[0], attempt, durationMs: raw.durationMs });
      if (attempt >= UNRESPONSIVE_MAX_RETRIES) {
        throw new AlarmError("cli-permanently-unresponsive", { node: this.node, command: argv[0], attempts: attempt });
      }
      await sleep(UNRESPONSIVE_BACKOFF_MS);
    }
  }

  /**
   * Independent second source: the `.md` files actually on disk in `<vaultPath>/<folder>`,
   * via `ls`. `ls` positively distinguishes empty-existing (exit 0, no entries) from missing
   * (exit ≠ 0), which obsidian-cli's `files` cannot. Returns "unavailable" when no vaultPath
   * is configured (local/dev) so callers skip the cross-check.
   */
  async listDirFs(folder: string): Promise<{ ok: true; entries: string[] } | { ok: false; reason: "missing" | "unavailable" }> {
    if (!this.vaultPath) return { ok: false, reason: "unavailable" };
    const raw = await this.runShell(["ls", "-1", `${this.vaultPath}/${folder}`]);
    if (raw.code !== 0) return { ok: false, reason: "missing" };
    const entries = raw.stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".md"));
    return { ok: true, entries };
  }

  // --- note mutations -------------------------------------------------------

  async createNote(name: string, content = ""): Promise<OpResult> {
    // The CLI's `name=` rejects "/", so a note inside a folder must be created via `path=`
    // (with the .md extension). read/append/open/delete take `file=` with the folder path.
    const p = name.includes("/") ? [`path=${name}.md`] : [`name=${name}`];
    if (content) p.push(`content=${content}`);
    const raw = await this.run("create", p);
    this.expect(raw, parseMutation);
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  /** Appends `line` plus a trailing newline. */
  async appendLine(name: string, line: string): Promise<OpResult> {
    const raw = await this.run("append", [`file=${name}`, `content=${line}`]);
    this.expect(raw, parseMutation);
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  /** Prepends `line` to the top of the note. */
  async prependLine(name: string, line: string): Promise<OpResult> {
    const raw = await this.run("prepend", [`file=${name}`, `content=${line}`]);
    this.expect(raw, parseMutation);
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  /** Read a note: ok+value = present content; !ok = positively absent. Retries while unparseable. */
  async read(name: string): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("read", [`file=${name}`], parseRead);
    return r.present ? { ok: true, value: r.content, raw } : { ok: false, raw };
  }

  /** Read by exact vault-relative path (needed for "(Conflicted copy …)" files). */
  async readByPath(path: string): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("read", [`path=${path}`], parseRead);
    return r.present ? { ok: true, value: r.content, raw } : { ok: false, raw };
  }

  /** Whether a note exists locally — keyed on the positively-identified read result. */
  async exists(name: string): Promise<boolean> {
    return (await this.read(name)).ok;
  }

  /** Open a note in the GUI (visible via VNC). Safe before first edit: a missing note is a
   *  positively-recognized no-op, not an error we abort on. */
  async open(name: string): Promise<OpResult> {
    const raw = await this.run("open", [`file=${name}`]);
    if (parseMutation(raw.stdout) === UNRECOGNIZED && !isNotFoundError(raw.stdout)) {
      throw new CliUnrecognizedOutput(raw, "parseMutation");
    }
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  async deleteNote(name: string, permanent = false): Promise<OpResult> {
    const p = [`file=${name}`];
    if (permanent) p.push("permanent");
    const raw = await this.run("delete", p);
    // Deleting an already-gone note is a harmless no-op (not-found is acceptable here).
    if (parseMutation(raw.stdout) === UNRECOGNIZED && !isNotFoundError(raw.stdout)) {
      throw new CliUnrecognizedOutput(raw, "parseMutation");
    }
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  // --- introspection / oracle inputs ---------------------------------------

  /** Vault file names, one per line (validated; throws on garbage). An empty list is
   *  returned as [] but is NOT a positive "empty folder" — confirm independently. */
  async listFiles(folder?: string): Promise<OpResult<string[]>> {
    const { value, raw } = await this.runRecognized("files", folder ? [`folder=${folder}`] : [], parseFilesList);
    return { ok: true, value, raw };
  }

  /** Just the "(Conflicted copy …)" files in the vault. */
  async listConflictFiles(): Promise<OpResult<string[]>> {
    const r = await this.listFiles();
    return { ...r, value: (r.value ?? []).filter(isConflictFile) };
  }

  /** Obsidian's own view: server-side sync versions (newest = 1). !ok = positively absent. */
  async diffSync(name: string): Promise<OpResult<SyncVersion[]>> {
    const { value: r, raw } = await this.runRecognized("diff", [`file=${name}`, "filter=sync"], parseSyncVersions);
    return r === "absent" ? { ok: false, raw } : { ok: true, value: r, raw };
  }

  /** Local (File recovery) version list. !ok = positively absent. */
  async history(name: string): Promise<OpResult<FileVersion[]>> {
    const { value: r, raw } = await this.runRecognized("history", [`file=${name}`], parseFileVersions);
    return r === "absent" ? { ok: false, raw } : { ok: true, value: r, raw };
  }

  // --- Sync control & introspection (require a Sync-linked vault) -----------

  async syncPause(): Promise<OpResult> {
    return this.expectSyncToggle(await this.run("sync", ["off"]));
  }

  async syncResume(): Promise<OpResult> {
    return this.expectSyncToggle(await this.run("sync", ["on"]));
  }

  // `sync on`/`off` print "Sync resumed."/"Sync paused." — recognize a `Sync …` line; an
  // empty/Error reply is unrecognized → `-UNKNOWN`. A control command (side-effecting), so it
  // fails fast — never retried.
  private expectSyncToggle(raw: ExecResult): OpResult {
    const t = raw.stdout.trim();
    if (t === "" || t.startsWith("Error:") || !/^Sync\b/.test(t)) throw new CliUnrecognizedOutput(raw, "expectSyncToggle");
    return { ok: true, value: t, raw };
  }

  /** Authoritative sync state — returns the validated status word (e.g. "synced"). */
  async syncStatus(): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("sync:status", [], parseSyncStatus);
    return { ok: true, value: r.status, raw };
  }

  /**
   * Bounded, pollable sync-state probe for the settle loop. `sync:status` BLOCKS until the
   * node is synced (it returns immediately only when synced), so a short timeout turns it
   * into a "synced yet?" poll: a quick return is the real status word; a timeout (killed) is
   * reported as `"timeout"` — NOT inferred as "syncing", since a killed call carries no
   * positively-confirmed reply, only the fact that it didn't return in time; an unreadable
   * reply → "?" (logged once, caller keeps polling — the settle cap bounds a persistently-bad
   * node as `-TIMEOUT`). Unlike `run`, a timeout here is EXPECTED, not an outage, so it never
   * reaches the killed→ALARM path.
   */
  async syncStateProbe(timeoutMs: number): Promise<string> {
    assert(timeoutMs > 0, "syncStateProbe needs a positive timeout");
    const raw = await this.executor.exec(["sync:status"], { timeoutMs });
    if (raw.killed) return "timeout"; // no positively-confirmed reply — don't assert a specific state
    const r = parseSyncStatus(raw.stdout);
    if (r === UNRECOGNIZED) {
      this.emit({ kind: "sync-status-unreadable", node: this.node, stdout: raw.stdout });
      return "?";
    }
    return r.status;
  }

  // --- diagnostic snapshots (mid-history, e.g. after a P) --------------------
  //
  // A snapshot is a LOOK, not a JUDGMENT: exactly one bounded attempt, whatever comes back
  // (even "timeout" or garbage) is what gets recorded — never the paranoid oracle-grade
  // retry-for-recognition (`runRecognized`, up to ~30s) or retry-for-unresponsiveness
  // (`run`/`runShell`, up to ~10min). Those retries exist to get a TRUSTWORTHY answer for a
  // correctness verdict; a diagnostic snapshot wants "what does it look like RIGHT NOW",
  // and must never itself become a multi-minute stall. Every call here is capped by
  // `timeoutMs` and never throws.

  /** Single bounded attempt to read a note. Never retries; a timeout or unrecognized reply
   *  is reported as such, not chased. */
  async snapshotRead(name: string, timeoutMs: number): Promise<{ status: "present" | "absent" | "unrecognized" | "timeout"; content?: string }> {
    const raw = await this.executor.exec(["read", `file=${name}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseRead(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", content: raw.stdout };
    return r.present ? { status: "present", content: r.content } : { status: "absent" };
  }

  /** Single bounded attempt at the vault-relative file listing (CLI's own view — includes
   *  "(Conflicted copy …)" names). Never retries. */
  async snapshotFiles(folder: string, timeoutMs: number): Promise<{ status: "ok" | "unrecognized" | "timeout"; entries?: string[] }> {
    const raw = await this.executor.exec(["files", `folder=${folder}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseFilesList(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized" };
    return { status: "ok", entries: r };
  }

  /** Single bounded attempt at a direct `ls` of the vault folder (FS second-source). Never
   *  retries — contrast with `listDirFs`, which is for the settle-time CLI/FS cross-check
   *  and retries an untimely call for up to ~10min waiting for recovery (correct there,
   *  wrong for a snapshot). */
  async snapshotFs(folder: string, timeoutMs: number): Promise<{ status: "ok" | "missing" | "unavailable" | "timeout"; entries?: string[] }> {
    if (!this.vaultPath) return { status: "unavailable" };
    const raw = await this.executor.shell(["ls", "-1", `${this.vaultPath}/${folder}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    if (raw.code !== 0) return { status: "missing" };
    return { status: "ok", entries: raw.stdout.split("\n").map((l) => l.trim()).filter((l) => l.endsWith(".md")) };
  }

  /** Raw server-side sync version listing for a note. !ok = positively absent. */
  async syncHistory(name: string): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("sync:history", [`file=${name}`], parseSyncHistory);
    return r === "absent" ? { ok: false, raw } : { ok: true, value: r, raw };
  }

  /**
   * Cumulative count of server-side sync versions (`sync:history total`). !ok = positively
   * absent (no server history). Monotonic and server-side (all nodes agree).
   */
  async syncVersionsTotal(name: string): Promise<OpResult<number>> {
    const { value: r, raw } = await this.runRecognized("sync:history", [`file=${name}`, "total"], parseTotal);
    return r === "absent" ? { ok: false, raw } : { ok: true, value: r, raw };
  }

  /** Read a specific server-side sync version. !ok = absent file or no-such-version. */
  async syncRead(name: string, version: number): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("sync:read", [`file=${name}`, `version=${version}`], parseSyncRead);
    return r.kind === "content" ? { ok: true, value: r.content, raw } : { ok: false, raw };
  }

  // --- fault primitive (alternative) ----------------------------------------

  async setSyncPlugin(enabled: boolean): Promise<OpResult> {
    const cmd = enabled ? "plugin:enable" : "plugin:disable";
    const raw = await this.run(cmd, ["id=sync", "filter=core"]);
    return { ok: true, value: raw.stdout.trim(), raw };
  }
}

// --- shared helpers ----------------------------------------------------------

export function isConflictFile(name: string): boolean {
  // e.g. "Meeting notes (Conflicted copy MyMacBook2 202411281430).md"
  return /\(Conflicted copy .+\)\.md$/.test(name);
}
