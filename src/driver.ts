// Thin, PARANOID wrapper over the Obsidian CLI: `obsidian <command> key=value ...`.
//
// Every mutation goes through Obsidian (never a direct file write) so the app's own Sync
// engine is engaged exactly as it would be for a human edit.
//
// Trust model (see docs/cli-trust.md): the CLI always exits 0 and can return empty/garbage
// when the app or the container engine is unresponsive, so we NEVER take output at face value. Each call:
//   1. is bounded by a HARD timeout; if killed (untimely) we log `cli-unresponsive` and RETRY
//      (wait for recovery) — we never judge on a stalled read.
//   2. once timely, its output must be POSITIVELY identified by a recognizer (see cli-parse.ts);
//      anything unrecognized throws CliUnrecognizedOutput, which the run turns into a flagged
//      inconsistency and abort (so a future obsidian-cli format change fails loudly, not silently).

import assert from "node:assert/strict";
import type { Executor } from "./exec.js";
import type { ExecResult, FileVersion, OpResult, SyncHistoryVersion, SyncVersion } from "./types.js";
import {
  CliUnrecognizedOutput, UNRECOGNIZED, type Unrecognized,
  parseRead, parseFilesList, parseSyncStatus, parseTotal, parseSyncRead,
  parseSyncVersions, parseFileVersions, parseMutation, parseSyncHistory, parseSyncHistoryVersions,
  parseVaultName, parseVaultList, type VaultEntry, isNotFoundError,
} from "./cli-parse.js";
import { CliInconsistencyError } from "./inconsistency.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait-for-recovery bounds for an unresponsive CLI: retry every BACKOFF up to MAX_RETRIES
// (~10 min), then it's a permanent outage — flagged as a CliInconsistencyError.
const UNRESPONSIVE_BACKOFF_MS = 5_000;
const UNRESPONSIVE_MAX_RETRIES = 120;

// Wait-for-recovery bounds for a read whose output isn't (yet) parseable — typically a node
// mid-(re)connect reporting `Error: Sync is in error state.` on a sync command. Retry every
// BACKOFF up to MAX_RETRIES hoping the reply becomes recognizable. Then the rep ends `-UNKNOWN`.
const RECOGNIZE_BACKOFF_MS = 2_000;
const RECOGNIZE_MAX_RETRIES = 15;
// Per-attempt bound for a runRecognized() call — some commands (`sync:history ... total` in
// particular) can themselves silently block for a long time once Sync hasn't caught up yet (see
// readTotals's comment in execute.ts and docs/cli-trust.md), with zero signal while in flight
// under an unbounded call. Bounding each attempt turns a long silent stall into a visible,
// retried sequence — worst case MAX_RETRIES × (CALL_TIMEOUT + BACKOFF), well under the settle
// cap so one read can't dominate a settle (full story: docs/cli-trust.md).
const RECOGNIZE_CALL_TIMEOUT_MS = 5_000;

export class ObsidianDriver {
  /** Optional per-rep sink for cli-unresponsive events (set to RunLogger.log); else console. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Backoff between recognize-retries; overridable so tests don't wait real seconds. */
  recognizeBackoffMs = RECOGNIZE_BACKOFF_MS;
  /** Per-attempt timeout inside runRecognized(); overridable for tests. */
  recognizeCallTimeoutMs = RECOGNIZE_CALL_TIMEOUT_MS;

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

  // No command here ever passes `vault=`. Each node runs exactly one vault, and for the local
  // instance the vault is established by checking (local-vault.ts's requireActiveVault), not by
  // asking the CLI to switch — `vault=` cannot switch. A pin that passed it anyway used to live
  // here; see docs/DESIGN.md, "Dead end: pinning the vault".
  //
  // Runs the command with a hard timeout; on an untimely (killed) result, waits and retries
  // until the CLI responds. Returns only a TIMELY ExecResult (never a killed one).
  private async run(command: string, params: string[] = []): Promise<ExecResult> {
    for (let attempt = 1; ; attempt++) {
      const raw = await this.executor.exec([command, ...params]);
      if (!raw.killed) return raw;
      this.emit({ kind: "cli-unresponsive", node: this.node, command, attempt, durationMs: raw.durationMs });
      if (attempt >= UNRESPONSIVE_MAX_RETRIES) {
        throw new CliInconsistencyError("cli-permanently-unresponsive", { node: this.node, command, attempts: attempt });
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
   * Read-only call with retry-for-recovery: bounded to recognizeCallTimeoutMs per attempt — NOT
   * via this.run()'s own untimely-retry, which stays reserved for mutations (see docs/cli-trust.md
   * for why reads and mutations retry differently). Two distinct reasons an attempt doesn't yet
   * produce a value, both retried the same way, same budget:
   *   - the call TIMED OUT (`raw.killed`) — logged as `cli-call-timeout-retry`.
   *   - the call answered but with something UNRECOGNIZED (e.g. a node mid-(re)connect answering
   *     a sync command with `Error: Sync is in error state.`) — logged as
   *     `cli-output-unrecognized-retry`.
   * After RECOGNIZE_MAX_RETRIES (of either kind, combined) it gives up and throws
   * CliUnrecognizedOutput (→ `-UNKNOWN`), naming the recognizer. SAFE only for idempotent reads
   * — never use for a mutation.
   *
   * Each attempt is timed (`callMs`). A retry sequence that eventually succeeds logs that too
   * (`cli-output-recognized-after-retry`, attempt > 0) — the common "recognized on the first
   * try" case stays silent, as before.
   */
  private async runRecognized<T>(
    command: string,
    params: string[],
    recognize: (stdout: string) => T | Unrecognized,
  ): Promise<{ value: T; raw: ExecResult }> {
    const sequenceStart = Date.now();
    for (let attempt = 0; ; attempt++) {
      const callStart = Date.now();
      const raw = await this.executor.exec([command, ...params], { timeoutMs: this.recognizeCallTimeoutMs });
      const callMs = Date.now() - callStart;
      if (raw.killed) {
        if (attempt >= RECOGNIZE_MAX_RETRIES) throw new CliUnrecognizedOutput(raw, recognize.name);
        this.emit({
          kind: "cli-call-timeout-retry",
          node: this.node, command, recognizer: recognize.name, attempt: attempt + 1, callMs,
        });
        await sleep(this.recognizeBackoffMs);
        continue;
      }
      const result = recognize(raw.stdout);
      if (result !== UNRECOGNIZED) {
        if (attempt > 0) {
          this.emit({
            kind: "cli-output-recognized-after-retry",
            node: this.node, command, recognizer: recognize.name,
            attempts: attempt + 1, callMs, totalMs: Date.now() - sequenceStart,
          });
        }
        return { value: result, raw };
      }
      if (attempt >= RECOGNIZE_MAX_RETRIES) throw new CliUnrecognizedOutput(raw, recognize.name);
      this.emit({
        kind: "cli-output-unrecognized-retry",
        node: this.node, command, recognizer: recognize.name, attempt: attempt + 1, stdout: raw.stdout, callMs,
      });
      await sleep(this.recognizeBackoffMs);
    }
  }

  /** Like `run`, but for a non-idempotent content mutation (append/create/prepend): a timeout
   *  here means we genuinely don't know whether the mutation already took effect before the
   *  CLI's response was lost — retrying blindly risks silently duplicating content (confirmed
   *  live: an append that timed out at the ~120s default, then succeeded on retry 5s later,
   *  left its token appended TWICE — a harness-caused duplicate that would otherwise misattribute
   *  a real Obsidian bug). Never retries: a single timeout throws immediately, ending this rep as
   *  -UNKNOWN rather than risking a silent duplicate. `open`/`deleteNote`/`syncResume`/
   *  `syncPause` stay on `run()` — genuinely idempotent, safe to retry. */
  private async runMutationOnce(command: string, params: string[] = []): Promise<ExecResult> {
    const raw = await this.executor.exec([command, ...params]);
    if (raw.killed) {
      throw new CliInconsistencyError("cli-mutation-unresponsive", { node: this.node, command, durationMs: raw.durationMs });
    }
    return raw;
  }

  /** Like `run`, but for a raw node-shell command (FS second-source); same untimely-retry. */
  private async runShell(argv: string[]): Promise<ExecResult> {
    for (let attempt = 1; ; attempt++) {
      const raw = await this.executor.shell(argv);
      if (!raw.killed) return raw;
      this.emit({ kind: "cli-unresponsive", node: this.node, command: argv[0], attempt, durationMs: raw.durationMs });
      if (attempt >= UNRESPONSIVE_MAX_RETRIES) {
        throw new CliInconsistencyError("cli-permanently-unresponsive", { node: this.node, command: argv[0], attempts: attempt });
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

  /**
   * Independent second source for CONTENT: the bytes actually in `<vaultPath>/<relPath>`, via
   * `cat`. The sibling of `listDirFs`, and the same trust policy — retries an untimely call,
   * throws if it never answers — because it too is only used at the settled verdict.
   *
   * `relPath` is vault-relative and carries its own extension (`bughunt/x-a-H.md`), matching what
   * `files` reports, so a conflict file's own name can be handed straight in.
   *
   * Costs nothing the CLI would not: `cat` and `read` measure the same, since the exec round trip
   * is the whole cost (docs/DESIGN.md). It is not a cheaper `read` — it is a DIFFERENT witness,
   * which is the entire point: `read` says what Obsidian believes, `cat` says what is on disk.
   */
  async readFileFs(relPath: string): Promise<{ ok: true; content: string } | { ok: false; reason: "missing" | "unavailable" }> {
    if (!this.vaultPath) return { ok: false, reason: "unavailable" };
    const raw = await this.runShell(["cat", `${this.vaultPath}/${relPath}`]);
    if (raw.code !== 0) return { ok: false, reason: "missing" }; // cat exits non-zero for "no such file"
    return { ok: true, content: raw.stdout };
  }

  // --- note mutations -------------------------------------------------------

  /**
   * Run several CLI invocations in one round trip, returning each stdout separately.
   *
   * The round trip IS the cost: an empty `docker exec` measured 68ms against these containers while
   * `read`/`create`/`open` measured 62-66ms each, so the Obsidian work is under the exec's own noise
   * floor. Four calls went 259ms -> 71ms batched (2026-09-06).
   *
   * Falls back to running them one at a time when the executor cannot batch, so callers get the same
   * outputs either way and never have to branch on the transport.
   */
  async batch(
    cmds: string[][],
    timeoutMs?: number,
    /** Per-command bounds, overriding `timeoutMs` where present. See `Executor.execBatch`. */
    perCmdMs?: (number | undefined)[],
    // `raw` is the whole reply, kept for the one case that has nothing else to show: a batch that
    // could not be split into one output per command has no per-command outputs at all, and a
    // reader still needs to see what came back.
  ): Promise<{ ok: boolean; outputs: string[]; killed: boolean[]; timedOut: boolean; raw: string }> {
    if (this.executor.execBatch) {
      const r = await this.executor.execBatch(cmds, { timeoutMs, perCmdMs });
      // `timedOut` is the WHOLE round trip being killed, which is a different thing from a split
      // that did not line up — one means the node stopped answering, the other that it answered
      // something we cannot cut apart. The mutation path has to tell them apart.
      return { ok: r.ok, outputs: r.outputs, killed: r.killed, timedOut: r.raw.killed, raw: r.raw.stdout };
    }
    // Fallback for an executor that cannot batch: same calls, same order, each bounded on its own,
    // and one that runs out of time does NOT stop the rest — the container path's behaviour.
    const outputs: string[] = [];
    const killed: boolean[] = [];
    for (let i = 0; i < cmds.length; i++) {
      const ms = perCmdMs?.[i] ?? timeoutMs;
      const raw = await this.executor.exec(cmds[i], ms === undefined ? undefined : { timeoutMs: ms });
      outputs.push(raw.stdout);
      killed.push(raw.killed);
    }
    return { ok: true, outputs, killed, timedOut: killed.some(Boolean), raw: outputs.join("\n---\n") };
  }

  /**
   * Make one edit and read it back, in a single round trip.
   *
   * Exactly the calls the un-batched path made — an optional leading `sync:history total`, an
   * optional `open`, then `create` or `append`, then the confirming `read` — with the same parsers
   * on the same outputs. Only the transport is shared,
   * so nothing in docs/cli-trust.md is relaxed: an unrecognized mutation reply or a split that does
   * not yield one output per command returns `ok: false`, and the caller retries rather than
   * proceeding on a guess.
   *
   * The write is issued ONCE, never retried inside here, for the same reason `runMutationOnce`
   * exists: a retried append that actually landed the first time duplicates a token and trips the
   * duplication oracle.
   *
   * BATCHED, SEQUENTIAL is not a preference here, it is forced: each call depends on the one before
   * it, and unbatched + sequential is the single arrangement `make bench-cli` finds slow — it pays
   * the exec round trip once per call end to end. Batching is what keeps a path that has to be
   * sequential out of that cell. Measured against Obsidian 1.13.7 under Docker on macOS; see
   * `docs/DESIGN.md`, "How the calls are issued", and check-assumptions, which re-measures it.
   */
  async editAndConfirm(
    name: string,
    token: string,
    o: {
      create: boolean;
      open: boolean;
      /** Also take this note's version-counter baseline, as the FIRST command of the same batch.
       *  Costs no round trip, and the ordering is stronger than a separate call can be: the read
       *  and the write are consecutive statements of one `sh -c`, so nothing at all can happen
       *  between them. Bounded on its own (`versionsMs`) while the write stays unbounded — see the
       *  `perCmdMs` note on `Executor.execBatch` for why that distinction has to exist. */
      versionsMs?: number;
    },
  ): Promise<{
    ok: boolean; present: boolean; content: string | null; notFound?: boolean;
    /** Present only when `versionsMs` was given. Same shape `snapshotVersionsTotal` returns, so a
     *  caller can treat the two interchangeably. */
    versions?: { status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string };
  }> {
    const miss = { ok: false, present: false, content: null };
    const write = o.create
      // The CLI's `name=` rejects "/", so a note in a folder must be created via `path=`.
      ? ["create", ...(name.includes("/") ? [`path=${name}.md`] : [`name=${name}`]), `content=${token}`]
      : ["append", `file=${name}`, `content=${token}`];
    const openCmd = ["open", `file=${name}`];
    // Ordering mirrors the un-batched path: for an existing note the GUI is foregrounded before the
    // edit, for a new one it can only be opened after the file exists.
    const body = o.create
      ? [write, ...(o.open ? [openCmd] : []), ["read", `file=${name}`]]
      : [...(o.open ? [openCmd] : []), write, ["read", `file=${name}`]];
    // The baseline goes at the HEAD, ahead of even the `open`: it must be a reading of the counter
    // as it stood before this edit existed, and the head is the only position where that needs no
    // argument about how quickly the counter refreshes.
    const wantVersions = o.versionsMs !== undefined;
    const cmds = wantVersions ? [["sync:history", `file=${name}`, "total"], ...body] : body;
    const off = wantVersions ? 1 : 0;

    const r = await this.batch(cmds, undefined, wantVersions ? [o.versionsMs, ...body.map(() => undefined)] : undefined);
    // A mutation whose call never came back is an APPARATUS failure, not a rep outcome: the harness
    // aborts the rep as an inconsistency rather than retrying, because a write that may or may not
    // have landed cannot be safely repeated. `runMutationOnce` has always thrown here, and batching
    // the write quietly downgraded it to an ordinary retry until this line.
    if (r.timedOut) {
      throw new CliInconsistencyError("cli-mutation-unresponsive", {
        node: this.node, command: o.create ? "create" : "append", durationMs: 0,
      });
    }
    if (!r.ok) return miss;
    // Parsed with the same rules `snapshotVersionsTotal` uses, so the two are interchangeable: a
    // killed command is a timeout, an unparseable one is `unrecognized`, and NEITHER is allowed to
    // affect the write's own outcome — a baseline we could not read costs the caller its
    // corroboration, never its edit.
    const versions = wantVersions
      ? ((): { status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string } => {
        if (r.killed[0]) return { status: "timeout" };
        const t = parseTotal(r.outputs[0]);
        if (t === UNRECOGNIZED) return { status: "unrecognized", raw: r.outputs[0] };
        return t === "absent" ? { status: "absent" } : { status: "ok", total: t };
      })()
      : undefined;
    const writeOut = r.outputs[off + (o.create ? 0 : (o.open ? 1 : 0))];
    // `append` to a note this node does not have answers `Error: File "..." not found.` — it does
    // NOT silently no-op, as a comment in execute.ts long claimed. That makes "you should have
    // created it" a POSITIVE reply rather than an inference, which is what lets the caller try an
    // append first and only then create, with no speculative read in front.
    if (!o.create && isNotFoundError(writeOut)) return { ok: true, present: false, content: null, notFound: true, versions };
    if (parseMutation(writeOut) === UNRECOGNIZED) return { ...miss, versions }; // never guess at a mutation's reply
    const read = parseRead(r.outputs[r.outputs.length - 1]);
    if (read === UNRECOGNIZED) return { ...miss, versions };
    return read.present
      ? { ok: true, present: true, content: read.content ?? null, versions }
      : { ok: true, present: false, content: null, versions }; // positively absent, which is a real answer
  }

  // --- what an observation of one note MEANS ---------------------------------
  //
  // Two paths ask these same questions: `gatherObservation` (oracle-grade, retries until every
  // reply is recognized, throws on a contradiction) and `sampleNotes` (a bounded look that must
  // never stall or throw). They differ only in TRUST POLICY — how hard they try, and what they do
  // when the readings do not agree with each other. The interpretation is identical, so it lives
  // here once: a
  // future fix to what counts as a conflict copy, or to the cross-check, reaches both.

  /** The conflict copies of `note` within a folder listing. */
  static conflictsOf(files: string[], note: string): string[] {
    return files.filter((f) => isConflictFile(f) && f.startsWith(`${note} (Conflicted copy`));
  }

  /**
   * Does the folder listing contradict the read?
   *
   * If the note read as PRESENT, the listing must contain it. When a listing omits a note we just
   * read, both replies arrived and both parsed — they simply cannot both be right, and taking the
   * listing at face value has fabricated a false "loss" before now (the founding incident in
   * docs/cli-trust.md). Callers decide what to DO about it: the oracle throws, the sampler reports.
   *
   * `listingUsable` is required, and false means "no opinion": an unreadable listing cannot
   * contradict anything, and treating it as a contradiction would invent evidence.
   */
  static listingContradictsRead(present: boolean, listingUsable: boolean, files: string[], note: string): boolean {
    return present && listingUsable && !files.includes(`${note}.md`);
  }

  /**
   * A batch run with the paranoid discipline: retry until EVERY output is positively recognized,
   * then hand back the parsed values. Same contract as `runRecognized`, one round trip instead of N.
   *
   * The retry is on the WHOLE batch, which is the honest way to do it here: a batch that came back
   * unsplittable, or with any part unreadable, has not produced a trustworthy picture of that node,
   * and re-asking one command would pair a fresh answer with stale neighbours. These commands are
   * all read-only — the mutation path never batches through here — so re-running them is free of
   * consequence.
   *
   * Throws `CliUnrecognizedOutput` after RECOGNIZE_MAX_RETRIES, exactly as the single-call path
   * does: an answer we cannot identify is never returned as if it were one.
   */
  private async batchRecognized<T extends readonly unknown[]>(
    cmds: string[][],
    recognizers: { [K in keyof T]: (stdout: string) => T[K] | Unrecognized },
    opts?: {
      /** Per-command caps, as `Executor.execBatch` takes them. Unset entries keep
       *  `recognizeCallTimeoutMs`, so the oracle-grade commands are unaffected. */
      perCmdMs?: (number | undefined)[];
      /** Commands whose non-answer must NOT force a retry or fail the batch. A best-effort slot
       *  comes back as `UNRECOGNIZED` for the caller to interpret — which is why the returned
       *  `killed` matters: it is the only thing that tells "blocked" (the node is busy syncing,
       *  itself a reading) apart from "said something we do not parse". */
      bestEffort?: boolean[];
    },
  ): Promise<{ values: T; killed: boolean[] }> {
    const required = (i: number): boolean => !(opts?.bestEffort?.[i] ?? false);
    for (let attempt = 0; ; attempt++) {
      const r = await this.batch(cmds, this.recognizeCallTimeoutMs, opts?.perCmdMs);
      // A command killed at its own cap is UNRECOGNIZED here regardless of what it managed to emit:
      // a truncated reply must never be parsed as if it were a complete one. The oracle path retries
      // it; only the bounded sampler is allowed to record "I ran out of time" as an answer.
      const parsed = r.ok
        ? recognizers.map((rec, i) => (r.killed[i] ? UNRECOGNIZED : rec(r.outputs[i])))
        : [UNRECOGNIZED];
      // Only the REQUIRED slots gate the batch. A best-effort slot that did not answer is a gap in
      // an extra, not a batch that "has not produced a trustworthy picture of that node".
      const missing = r.ok ? parsed.some((pv, i) => pv === UNRECOGNIZED && required(i)) : true;
      if (r.ok && !missing) return { values: parsed as unknown as T, killed: r.killed };
      if (attempt >= RECOGNIZE_MAX_RETRIES) {
        // `batch` hands back only ok+outputs, so synthesise the ExecResult the error wants. The
        // joined stdout is what a reader needs to see: which part of the batch was unreadable.
        throw new CliUnrecognizedOutput({
          argv: cmds.flat(), code: r.ok ? 0 : 1, stdout: r.outputs.join("\n---\n"),
          stderr: r.ok ? "" : "batch could not be split into one output per command",
          startedAt: new Date().toISOString(), durationMs: 0, killed: !r.ok,
        }, "batchRecognized");
      }
      this.emit({
        kind: "cli-batch-unrecognized-retry",
        node: this.node, commands: cmds.map((c) => c[0]), attempt: attempt + 1, split: r.ok,
        // WHICH command was unreadable and what it actually said. "One of these five did not parse"
        // is not something anyone can act on; the offending bytes are.
        unrecognized: r.ok
          ? parsed.flatMap((pv, i) => pv === UNRECOGNIZED && required(i)
            ? [{ command: cmds[i][0], killed: r.killed[i], stdout: r.outputs[i] }] : [])
          : [],
        // A batch that could not be split has no per-command outputs, so the whole reply is the
        // only thing there is to show.
        ...(r.ok ? {} : { stdout: r.raw }),
      });
      await sleep(this.recognizeBackoffMs);
    }
  }

  /** The oracle-grade read of one note plus the folder listing, in ONE round trip. Both are
   *  retried-until-recognized together; the caller does the CLI-vs-listing cross-check. */
  async readWithListing(note: string, folder?: string, versionsMs?: number): Promise<{
    canonical: string | null;
    files: string[];
    /** Only when `versionsMs` was asked for. Same shape `snapshotVersionsTotal` returns, so a
     *  caller can treat the two interchangeably. */
    versions?: { status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string };
  }> {
    // The server counter RIDES ALONG in the same exec rather than costing a call of its own. This
    // runs on every settle poll of every rep, so a second round trip here would be the single most
    // expensive thing the harness does — see docs/DESIGN.md: the exec round trip is the whole cost,
    // and a command added to a batch pays only its own work.
    //
    // It goes at the HEAD for the same reason the write path puts it there: it is the call most
    // likely to block (bounded, and on a node with no network it blocks until its cap), so it is
    // the one that must be capped and the one whose cap must not eat into anything else.
    //
    // BEST-EFFORT, and that is load-bearing. `sync:history` blocks on a disconnected node, and `D`
    // is an ordinary op — letting a blocked counter make this batch "unrecognized" would retry the
    // oracle-grade read on every settle poll of every history containing a D, and then throw. The
    // read and the listing keep their old contract exactly; the counter is an extra that may be
    // absent.
    const wantVersions = versionsMs !== undefined;
    const cmds = [
      ...(wantVersions ? [["sync:history", `file=${note}`, "total"]] : []),
      ["read", `file=${note}`],
      ["files", ...(folder ? [`folder=${folder}`] : [])],
    ];
    const recognizers = [...(wantVersions ? [parseTotal] : []), parseRead, parseFilesList];
    const { values, killed } = await this.batchRecognized<readonly unknown[]>(
      cmds, recognizers as never,
      wantVersions
        ? { perCmdMs: [versionsMs, undefined, undefined], bestEffort: [true, false, false] }
        : undefined,
    );
    const off = wantVersions ? 1 : 0;
    const r = values[off] as Exclude<ReturnType<typeof parseRead>, Unrecognized>;
    const files = values[off + 1] as string[];
    // Parsed exactly as `editAndConfirm` parses its own baseline, so the two are interchangeable:
    // killed is a timeout (the node is busy — itself a reading), unparseable is `unrecognized`, and
    // neither is allowed to affect the read or the listing.
    const versions = wantVersions
      ? ((): { status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string } => {
        if (killed[0]) return { status: "timeout" };
        const t = values[0] as ReturnType<typeof parseTotal>;
        if (t === UNRECOGNIZED) return { status: "unrecognized" };
        return t === "absent" ? { status: "absent" } : { status: "ok", total: t };
      })()
      : undefined;
    return { canonical: r.present ? (r.content ?? null) : null, files, ...(versions ? { versions } : {}) };
  }

  /** Oracle-grade reads of several exact vault paths, in one round trip. */
  async readPathsRecognized(paths: string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const { values: out } = await this.batchRecognized<unknown[]>(
      paths.map((p) => ["read", `path=${p}`]),
      paths.map(() => parseRead) as never,
    );
    return out.map((v) => {
      const r = v as Exclude<ReturnType<typeof parseRead>, Unrecognized>;
      return r.present ? (r.content ?? "") : "";
    });
  }

  /**
   * One node's whole picture for a set of notes: its sync state, the folder listing, and each note's
   * server version count, content and conflict files.
   *
   * Issued as separate execs, all in flight at once — see the note on the call below, and
   * `docs/DESIGN.md`, "How the calls are issued". Bounded and non-retrying like the other
   * `snapshot*` calls: a look, never a judgment. Every reply is parsed by the same parser it would
   * have had alone.
   *
   * Conflict files matter here because a token sitting in one is NOT lost — the oracle counts it as
   * `onlyInConflict`. A sampler that read the note alone would report loss the moment a merge moved
   * a token into a conflict copy, which is a different and much less serious thing.
   */
  async sampleNotes(folder: string, notes: string[], timeoutMs: number, withUploads = false): Promise<{
    ok: boolean;
    sync: string;
    per: Map<string, { versStatus: string; vers: number | null; uploads?: SyncHistoryVersion[]; fileStatus: string; content: string; conflicts: string[]; inconsistent: boolean; versRaw?: string; fileRaw?: string }>;
  }> {
    const per = new Map<string, { versStatus: string; vers: number | null; uploads?: SyncHistoryVersion[]; fileStatus: string; content: string; conflicts: string[]; inconsistent: boolean; versRaw?: string; fileRaw?: string }>();

    // PARALLEL, not batched — though the honest reason is weaker than it once looked. An early
    // measurement said 371ms batched against 284ms as parallel execs; running the full matrix
    // repeatedly (`make bench-cli`, and the table in docs/DESIGN.md) showed that difference was
    // noise, and the two are indistinguishable. What IS real is that unbatched + SEQUENTIAL costs
    // ~500ms, because it pays the ~65ms exec overhead four times end to end.
    //
    // So: parallel matters, batched-or-not does not, and this form is kept because it gives each
    // call its own timeout for free. The write path batches for a different and still-valid reason —
    // it is inherently sequential (read, write, read back), so unbatched would put it in the one
    // slow cell.
    //
    // THIS IS A MEASUREMENT, AND IT IS OF ONE ENVIRONMENT: Obsidian 1.13.7 under Docker on macOS.
    // It holds because the exec round trip dominates, and an engine or CLI that changed that would
    // move the whole ranking. `make bench-cli` re-measures all eight cells; check-assumptions runs
    // it and complains if this cell stops being among the fast ones.
    const [sync, listing, ...reads] = await Promise.all([
      this.syncStateProbe(timeoutMs),
      this.snapshotFiles(folder, timeoutMs),
      // `withUploads` swaps `sync:history total` for the LISTING, which is the same call without the
      // flag: measured 87-117ms against the counter's 83-176ms, and `total` equals the row count, so
      // it is strictly more information at the same price. Off by default — the harness needs only
      // the count, and a caller should opt into carrying rows it will not read.
      ...notes.flatMap((n) => [
        withUploads ? this.snapshotSyncHistory(n, timeoutMs) : this.snapshotVersionsTotal(n, timeoutMs),
        this.snapshotRead(n, timeoutMs),
      ]),
    ]);
    const files = listing.status === "ok" ? (listing.entries ?? []) : [];
    // A listing that timed out or could not be parsed has NO OPINION, so it must not be allowed to
    // contradict a read (see listingContradictsRead).
    const listingUsable = listing.status === "ok";

    const wanted: string[] = []; // conflict copies to fetch, usually none
    notes.forEach((n, i) => {
      const tot = reads[i * 2] as Awaited<ReturnType<ObsidianDriver["snapshotVersionsTotal"]>>
        & Awaited<ReturnType<ObsidianDriver["snapshotSyncHistory"]>>;
      const rd = reads[i * 2 + 1] as Awaited<ReturnType<ObsidianDriver["snapshotRead"]>>;
      const mine = ObsidianDriver.conflictsOf(files, n);
      wanted.push(...mine);
      const present = rd.status === "present";
      // The same CLI-vs-listing cross-check the oracle-grade read does (see gatherObservation).
      // Both halves are already in hand, so the check is free; unlike the oracle path it must never
      // throw, so the caller records it and the lane draws `!`.
      const inconsistent = ObsidianDriver.listingContradictsRead(present, listingUsable, files, n);
      per.set(n, {
        versStatus: tot.status,
        // One number from either form: the counter, or the listing's length. They agree — measured
        // from a note's genesis onward, `total` and the row count matched at every reading.
        vers: tot.status !== "ok" ? null : (tot.total ?? tot.versions?.length ?? null),
        ...(tot.versions !== undefined ? { uploads: tot.versions } : {}),
        fileStatus: inconsistent ? "inconsistent" : rd.status,
        content: present ? (rd.content ?? "") : "",
        conflicts: [],
        inconsistent,
        // Carried through so the `sample` event can show what could not be parsed. Present only
        // when there is something to show.
        ...(tot.raw !== undefined ? { versRaw: tot.raw } : {}),
        ...(rd.raw !== undefined ? { fileRaw: rd.raw } : {}),
      });
    });

    if (wanted.length > 0) {
      const bodies = await Promise.all(wanted.map((f) => this.snapshotReadByPath(f, timeoutMs)));
      wanted.forEach((f, i) => {
        const b = bodies[i];
        const body = b.status === "present" ? (b.content ?? "") : "";
        for (const [n, v] of per) if (ObsidianDriver.conflictsOf([f], n).length > 0) v.conflicts.push(body);
      });
    }
    return { ok: true, sync, per };
  }

  async createNote(name: string, content = ""): Promise<OpResult> {
    // The CLI's `name=` rejects "/", so a note inside a folder must be created via `path=`
    // (with the .md extension). read/append/open/delete take `file=` with the folder path.
    const p = name.includes("/") ? [`path=${name}.md`] : [`name=${name}`];
    if (content) p.push(`content=${content}`);
    const raw = await this.runMutationOnce("create", p);
    this.expect(raw, parseMutation);
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  /** Appends `line` plus a trailing newline. */
  async appendLine(name: string, line: string): Promise<OpResult> {
    const raw = await this.runMutationOnce("append", [`file=${name}`, `content=${line}`]);
    this.expect(raw, parseMutation);
    return { ok: true, value: raw.stdout.trim(), raw };
  }

  /** Prepends `line` to the top of the note. */
  async prependLine(name: string, line: string): Promise<OpResult> {
    const raw = await this.runMutationOnce("prepend", [`file=${name}`, `content=${line}`]);
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
    const { value, raw } = await this.runRecognized("files", [...(folder ? [`folder=${folder}`] : [])], parseFilesList);
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

  /** Authoritative sync state — returns the validated status word (e.g. "synced"). `sync:status`
   *  itself blocks until synced, so this retries (via runRecognized) until a valid status word
   *  comes back — bounded to ~105s total (RECOGNIZE_MAX_RETRIES × (recognizeCallTimeoutMs +
   *  recognizeBackoffMs)), same budget as every other runRecognized caller; a node that hasn't
   *  reached a synced baseline within that window surfaces as CliUnrecognizedOutput (→ `-UNKNOWN`)
   *  to whichever outer polling loop called this (waitNodesSynced/preflight/waitForQuiescence). */
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
   * reaches the killed→CliInconsistencyError path.
   */
  /** Is this node's container answering at all? True only when the ENGINE call itself succeeded —
   *  the CLI's own exit code is never trusted (see docs/cli-trust.md), but `exec` failing to reach a
   *  container is the engine's answer, not the CLI's, and that one is meaningful.
   *
   *  Deliberately `version` rather than `sync:status`: the latter BLOCKS until the node is synced,
   *  so a busy but perfectly healthy node would time out and read as absent. */
  async reachable(timeoutMs: number): Promise<boolean> {
    const raw = await this.executor.exec(["version"], { timeoutMs });
    return !raw.killed && raw.code === 0;
  }

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
  async snapshotRead(name: string, timeoutMs: number): Promise<{ status: "present" | "absent" | "unrecognized" | "timeout"; content?: string; raw?: string }> {
    const raw = await this.executor.exec(["read", `file=${name}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseRead(raw.stdout);
    // `raw`, not `content`: an unparsed reply is not the note's content, and calling it that
    // invited a caller to display it as one.
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    return r.present ? { status: "present", content: r.content } : { status: "absent" };
  }

  /** Single bounded attempt at the server-side version count. Never retries.
   *
   *  `syncVersionsTotal` goes through `runRecognized`, which retries for up to ~30s — fine for a
   *  verdict, fatal inside a sampling loop, where a call that quietly retried would time the retry
   *  rather than the thing being sampled. Note `sync:history` is also the call most likely to block:
   *  see docs/DESIGN.md on what it does with no network. */
  async snapshotVersionsTotal(name: string, timeoutMs: number): Promise<{ status: "ok" | "absent" | "unrecognized" | "timeout"; total?: number; raw?: string }> {
    const raw = await this.executor.exec(["sync:history", `file=${name}`, "total"], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseTotal(raw.stdout);
    // `raw` on every unrecognized reply, here and in the snapshots below. "We could not parse it"
    // is useless without the it: teaching the recognizer needs the exact bytes, and by the time
    // anyone reads the log the call is long gone. Not truncated — a reply worth reporting is worth
    // reporting whole.
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    return r === "absent" ? { status: "absent" } : { status: "ok", total: r };
  }

  /** Single bounded attempt to read an exact vault path — the form conflict copies need. Never
   *  retries; the bounded sibling of `readByPath`. */
  async snapshotReadByPath(path: string, timeoutMs: number): Promise<{ status: "present" | "absent" | "unrecognized" | "timeout"; content?: string; raw?: string }> {
    const raw = await this.executor.exec(["read", `path=${path}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseRead(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    return r.present ? { status: "present", content: r.content } : { status: "absent" };
  }

  /** Single bounded attempt at the vault-relative file listing (CLI's own view — includes
   *  "(Conflicted copy …)" names). Never retries. */
  async snapshotFiles(folder: string, timeoutMs: number): Promise<{ status: "ok" | "unrecognized" | "timeout"; entries?: string[]; raw?: string }> {
    const raw = await this.executor.exec(["files", `folder=${folder}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseFilesList(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
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

  /** Single bounded attempt to read the active vault's own name (`vault info=name`). Never
   *  retries; used only for the local instance's "is this still the same vault" guard (see
   *  assertLocalVaultUnchanged in execute.ts) — a vault name is an open string, so (unlike
   *  syncStateProbe's status words) this returns a discriminated result instead of a sentinel
   *  string, to avoid any collision with a real vault literally named "timeout". */
  async vaultNameProbe(timeoutMs: number): Promise<{ status: "ok"; name: string } | { status: "unrecognized" | "timeout"; raw?: string }> {
    const raw = await this.executor.exec(["vault", "info=name"], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseVaultName(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    return { status: "ok", name: r };
  }

  /** Single bounded attempt to list every vault Obsidian knows about, with its on-disk path
   *  (`vaults verbose`). Sibling of vaultNameProbe and used by the same guard
   *  (src/local-vault.ts): that one answers "which vault am I actually on", this one answers
   *  "which vaults could you have meant", so a mismatch can be reported with the real
   *  alternatives instead of just a complaint. Advisory — the guard still fails closed when
   *  this doesn't answer, it just loses the hint. */
  async vaultListProbe(timeoutMs: number): Promise<{ status: "ok"; vaults: VaultEntry[] } | { status: "unrecognized" | "timeout"; raw?: string }> {
    const raw = await this.executor.exec(["vaults", "verbose"], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseVaultList(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    return { status: "ok", vaults: r };
  }

  /**
   * When this note's versions were UPLOADED, newest first, as the server recorded it.
   *
   * The one per-NOTE upload signal the CLI exposes. `sync:status` is per node, so with two notes
   * outstanding on one writer it cannot say which upload a `synced` refers to; these rows can,
   * because each carries its own note, time and producing device.
   *
   * Bounded and non-retrying, like the other `snapshot*` calls: a look, never a judgment. The
   * ENTRY becomes visible only once a peer has the data (the same lag `snapshotVersionsTotal`
   * documents), but the TIME inside it is the upload's, so this reads the past accurately rather
   * than reporting the present promptly.
   */
  async snapshotSyncHistory(name: string, timeoutMs: number): Promise<{
    status: "ok" | "absent" | "unrecognized" | "timeout"; versions?: SyncHistoryVersion[]; raw?: string;
  }> {
    const raw = await this.executor.exec(["sync:history", `file=${name}`], { timeoutMs });
    if (raw.killed) return { status: "timeout" };
    const r = parseSyncHistoryVersions(raw.stdout);
    if (r === UNRECOGNIZED) return { status: "unrecognized", raw: raw.stdout };
    if (r === "absent") return { status: "absent" };
    return { status: "ok", versions: r };
  }

  /** Raw server-side sync version listing for a note. !ok = positively absent. */
  async syncHistory(name: string): Promise<OpResult> {
    const { value: r, raw } = await this.runRecognized("sync:history", [`file=${name}`], parseSyncHistory);
    return r === "absent" ? { ok: false, raw } : { ok: true, value: r, raw };
  }

  /**
   * How many versions of this file THIS NODE believes the server holds (`sync:history total`).
   * !ok = positively absent (no server history).
   *
   * "server-side (all nodes agree)" is how this used to be described, and it is misleading. The
   * number is a CACHED view, refreshed when the node syncs — not a live read of the server.
   * Measured (docs/DESIGN.md, `npm run probe-sync-versions`): after n1 appended, n1's OWN total
   * kept reporting the old value for ~9 seconds, and only rose at the moment n2 received the
   * content. Nodes therefore agree once both have caught up, not at any given instant, and the
   * count cannot reveal a sync in flight — during those 9s it looked exactly like idle.
   *
   * Monotonic per node. Useful for what it can answer: `< 1` means the file never reached the
   * server at all, which is `-NOUPLOAD`.
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

/** The states in which a node's Sync is NOT running. A fresh container boots `paused` and stays
 *  that way until something resumes it — run.ts's preflight, or `make unpause-sync` by hand.
 *
 *  `timeout` and `?` are deliberately absent: a call that was killed, or answered with something
 *  unrecognized, carries no positively-confirmed state, and treating a non-answer as "off" would
 *  invent the very condition this set exists to detect. Absence is checked separately, below. */
export const SYNC_OFF_STATES = new Set(["paused", "error", "stopped", "offline"]);

/**
 * Refuse to start against nodes that cannot answer, or whose Sync is not running.
 *
 * For the tools that reach the nodes WITHOUT going through run.ts's preflight — probe-propagation,
 * probe-sync-versions — each of which otherwise runs to completion against a broken world and
 * reports the damage as data.
 *
 * TWO conditions, because they fail in opposite directions and one cannot stand in for the other:
 *
 *   - ABSENT. `<engine> exec` itself fails. A down node cannot be detected from `sync:status`: the
 *     reply is empty, which parses as unrecognized, which is `?` — and `?` must stay non-committal
 *     for the reason above. Probed with `version`, which is cheap and, unlike `sync:status`, does
 *     not block. Without this the propagation probe ran its whole history against nothing, printing
 *     one `sync-status-unreadable` line per call and creating whatever it could.
 *   - PAUSED. Reachable, answering, but Sync was never started.
 *
 * It asserts rather than repairs, the same choice assertLocalSyncOn makes: a tool that quietly
 * fixed the world would be measuring a world other than the one the operator set up.
 */
export async function assertNodesReady(drivers: ObsidianDriver[], probeMs = 10_000): Promise<void> {
  const absent: string[] = [];
  await Promise.all(drivers.map(async (d) => {
    const raw = await d.reachable(probeMs);
    if (!raw) absent.push(d.node);
  }));
  if (absent.length > 0) {
    throw new Error(
      `node(s) not answering: ${absent.join(", ")} — is \`make containers-up\` done, and are the ` +
      `containers actually running? Nothing was run.`,
    );
  }
  const states = await Promise.all(drivers.map((d) => d.syncStateProbe(probeMs)));
  const off = drivers.map((d, i) => [d.node, states[i]] as const).filter(([, st]) => SYNC_OFF_STATES.has(st));
  if (off.length === 0) return;
  throw new Error(
    `Sync is not running on ${off.map(([n, st]) => `${n} (${st})`).join(", ")} — a fresh container ` +
    `boots paused. Resume it with \`make unpause-sync\` and re-run.`,
  );
}

export function isConflictFile(name: string): boolean {
  // e.g. "Meeting notes (Conflicted copy MyMacBook2 202411281430).md"
  return /\(Conflicted copy .+\)\.md$/.test(name);
}
