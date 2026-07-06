import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianDriver, isConflictFile } from "./driver.js";
import { CliUnrecognizedOutput } from "./cli-parse.js";
import { CliInconsistencyError } from "./inconsistency.js";
import type { Executor } from "./exec.js";
import type { ExecResult } from "./types.js";

test("isConflictFile matches the (Conflicted copy …) pattern", () => {
  assert.equal(isConflictFile("shared (Conflicted copy n2 202606211146).md"), true);
  assert.equal(isConflictFile("shared.md"), false);
});

// Executor that replays a queued list of stdout strings (one per exec call), so we can
// simulate a node answering `sync:history total` with the transient sync-error a few times
// before it reconnects and returns a real count. KILLED simulates an attempt that times out
// (runRecognized's own bounded per-attempt timeout) rather than answering at all.
const SYNC_ERR = "Error: Sync is in error state. Check sync settings.\n";
const KILLED = Symbol("killed");
class ScriptedExecutor implements Executor {
  id = "n1";
  calls = 0;
  constructor(private readonly outputs: (string | typeof KILLED)[]) {}
  async exec(args: string[]): Promise<ExecResult> {
    const out = this.outputs[Math.min(this.calls++, this.outputs.length - 1)];
    const killed = out === KILLED;
    return { argv: ["podman", "exec", "n1", "obs", ...args], code: 0, stdout: killed ? "" : out, stderr: "", startedAt: "", durationMs: 0, killed };
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("runRecognized: a read riding out a transient sync-error retries then returns the recovered value", async () => {
  const exec = new ScriptedExecutor([SYNC_ERR, SYNC_ERR, "7"]); // disconnected twice, then a real total
  const d = new ObsidianDriver(exec);
  d.recognizeBackoffMs = 0; // no real waiting in the test
  const events: Record<string, unknown>[] = [];
  d.onEvent = (e) => events.push(e);

  const r = await d.syncVersionsTotal("bughunt/x.md");
  assert.equal(r.ok, true);
  assert.equal(r.value, 7);
  assert.equal(exec.calls, 3); // two transient replies + the recovered one
  const retries = events.filter((e) => e.kind === "cli-output-unrecognized-retry");
  assert.equal(retries.length, 2);
  assert.equal(events[0].recognizer, "parseTotal");
  assert.equal(typeof retries[0].callMs, "number"); // each attempt is individually timed

  // The previously-silent case this exists for: a retry sequence that DOES eventually succeed
  // now logs it too — otherwise a slow-but-successful final call (see execute.ts's readTotals
  // comment on sync:history total blocking for tens of seconds) leaves no trace at all.
  const recovered = events.filter((e) => e.kind === "cli-output-recognized-after-retry");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].attempts, 3);
  assert.equal(recovered[0].recognizer, "parseTotal");
  assert.equal(typeof recovered[0].callMs, "number");
  assert.equal(typeof recovered[0].totalMs, "number");
});

test("runRecognized: recognized on the FIRST try stays silent — no recognized-after-retry noise for the common case", async () => {
  const d = new ObsidianDriver(new ScriptedExecutor(["7"]));
  const events: Record<string, unknown>[] = [];
  d.onEvent = (e) => events.push(e);

  await d.syncVersionsTotal("bughunt/x.md");
  assert.equal(events.length, 0);
});

test("runRecognized: a read that never recovers gives up as CliUnrecognizedOutput naming the recognizer", async () => {
  const d = new ObsidianDriver(new ScriptedExecutor([SYNC_ERR])); // stuck forever
  d.recognizeBackoffMs = 0;
  await assert.rejects(
    () => d.syncVersionsTotal("bughunt/x.md"),
    (err: unknown) => err instanceof CliUnrecognizedOutput && err.recognizer === "parseTotal",
  );
});

test("runRecognized: an attempt that times out (killed) retries via cli-call-timeout-retry then returns the recovered value", async () => {
  const exec = new ScriptedExecutor([KILLED, KILLED, "7"]); // two timed-out attempts, then a real total
  const d = new ObsidianDriver(exec);
  d.recognizeBackoffMs = 0;
  const events: Record<string, unknown>[] = [];
  d.onEvent = (e) => events.push(e);

  const r = await d.syncVersionsTotal("bughunt/x.md");
  assert.equal(r.ok, true);
  assert.equal(r.value, 7);
  assert.equal(exec.calls, 3);
  const timeouts = events.filter((e) => e.kind === "cli-call-timeout-retry");
  assert.equal(timeouts.length, 2);
  assert.equal(timeouts[0].recognizer, "parseTotal");
  assert.equal(typeof timeouts[0].callMs, "number");
  // Never even reaches recognize() on a killed attempt, so no unrecognized-retry noise mixed in.
  assert.equal(events.filter((e) => e.kind === "cli-output-unrecognized-retry").length, 0);
  const recovered = events.filter((e) => e.kind === "cli-output-recognized-after-retry");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].attempts, 3);
});

test("runRecognized: an attempt that ALWAYS times out gives up as CliUnrecognizedOutput too, not an infinite wait", async () => {
  const d = new ObsidianDriver(new ScriptedExecutor([KILLED])); // never once answers in time
  d.recognizeBackoffMs = 0;
  await assert.rejects(
    () => d.syncVersionsTotal("bughunt/x.md"),
    (err: unknown) => err instanceof CliUnrecognizedOutput && err.recognizer === "parseTotal",
  );
});

test("appendLine: a timed-out attempt throws immediately as cli-mutation-unresponsive, NEVER retried", async () => {
  // Unlike runRecognized/run, a mutation timeout must not be silently retried: confirmed live,
  // retrying an append whose first attempt actually landed (just too slowly to report back)
  // duplicated the token on disk. A single killed attempt here must throw right away.
  const exec = new ScriptedExecutor([KILLED, "Appended to: bughunt/x"]); // the 2nd entry must NEVER be reached
  const d = new ObsidianDriver(exec);
  await assert.rejects(
    () => d.appendLine("bughunt/x", "(n1-1-a)"),
    (err: unknown) => err instanceof CliInconsistencyError && err.reason === "cli-mutation-unresponsive",
  );
  assert.equal(exec.calls, 1, "must not retry a mutation that may have already taken effect");
});

// One canned ExecResult for every exec — used to drive the bounded sync:status probe.
class FixedExecutor implements Executor {
  id = "n1";
  lastTimeoutMs?: number;
  constructor(private readonly result: Partial<ExecResult>) {}
  async exec(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.lastTimeoutMs = opts?.timeoutMs;
    return { argv: ["podman", "exec", "n1", "obs", ...args], code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false, ...this.result };
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("syncStateProbe: a timed-out (killed) sync:status reads as 'timeout', not an outage or an inferred state", async () => {
  const exec = new FixedExecutor({ killed: true });
  const d = new ObsidianDriver(exec);
  assert.equal(await d.syncStateProbe(5000), "timeout"); // never enters the killed→CliInconsistencyError path; no unconfirmed guess
  assert.equal(exec.lastTimeoutMs, 5000); // the short cap was actually applied to the call
});

test("syncStateProbe: a quick recognized reply returns the status word", async () => {
  const d = new ObsidianDriver(new FixedExecutor({ stdout: "status: synced\nvault: TestVault" }));
  assert.equal(await d.syncStateProbe(5000), "synced");
});

test("syncStateProbe: an unreadable reply → '?' and a one-off event (caller keeps polling)", async () => {
  const d = new ObsidianDriver(new FixedExecutor({ stdout: "wat?" }));
  const events: Record<string, unknown>[] = [];
  d.onEvent = (e) => events.push(e);
  assert.equal(await d.syncStateProbe(5000), "?");
  assert.equal(events.filter((e) => e.kind === "sync-status-unreadable").length, 1);
});

// Executor that always answers the same canned exec/shell result and COUNTS calls — proves
// the snapshot* methods make exactly ONE attempt (no retry-for-recognition, no
// retry-for-unresponsiveness), unlike the paranoid read()/files()/listDirFs() they're
// deliberately NOT built on.
class CountingExecutor implements Executor {
  id = "n1";
  execCalls = 0;
  shellCalls = 0;
  lastExecTimeoutMs?: number;
  lastShellTimeoutMs?: number;
  constructor(private readonly execResult: Partial<ExecResult> = {}, private readonly shellResult: Partial<ExecResult> = {}) {}
  async exec(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.execCalls++;
    this.lastExecTimeoutMs = opts?.timeoutMs;
    return { argv: ["podman", "exec", "n1", "obs", ...args], code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false, ...this.execResult };
  }
  async shell(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.shellCalls++;
    this.lastShellTimeoutMs = opts?.timeoutMs;
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false, ...this.shellResult };
  }
}

test("snapshotRead: a killed reply → 'timeout' in exactly one attempt (no unresponsive retry)", async () => {
  const exec = new CountingExecutor({ killed: true });
  const d = new ObsidianDriver(exec);
  const r = await d.snapshotRead("bughunt/x", 50);
  assert.deepEqual(r, { status: "timeout" });
  assert.equal(exec.execCalls, 1);
  assert.equal(exec.lastExecTimeoutMs, 50);
});

test("snapshotRead: an unrecognized (empty) reply → 'unrecognized' in exactly one attempt (no recognize retry)", async () => {
  const exec = new CountingExecutor({ stdout: "" });
  const d = new ObsidianDriver(exec);
  const r = await d.snapshotRead("bughunt/x", 50);
  assert.equal(r.status, "unrecognized");
  assert.equal(exec.execCalls, 1); // NOT the ~15x runRecognized would attempt
});

test("snapshotRead: a present note returns its content in one attempt", async () => {
  const exec = new CountingExecutor({ stdout: "(n1-1-a)" });
  const d = new ObsidianDriver(exec);
  assert.deepEqual(await d.snapshotRead("bughunt/x", 50), { status: "present", content: "(n1-1-a)" });
  assert.equal(exec.execCalls, 1);
});

test("snapshotFiles: a killed reply → 'timeout' in exactly one attempt", async () => {
  const exec = new CountingExecutor({ killed: true });
  const d = new ObsidianDriver(exec);
  assert.deepEqual(await d.snapshotFiles("bughunt", 50), { status: "timeout" });
  assert.equal(exec.execCalls, 1);
});

test("snapshotFiles: a normal listing returns entries in one attempt", async () => {
  const exec = new CountingExecutor({ stdout: "bughunt/a.md\nbughunt/a (Conflicted copy n2 202606300000).md" });
  const d = new ObsidianDriver(exec);
  const r = await d.snapshotFiles("bughunt", 50);
  assert.equal(r.status, "ok");
  assert.equal(r.entries?.length, 2);
  assert.equal(exec.execCalls, 1);
});

test("vaultNameProbe: a killed reply → 'timeout' in exactly one attempt", async () => {
  const exec = new CountingExecutor({ killed: true });
  const d = new ObsidianDriver(exec);
  assert.deepEqual(await d.vaultNameProbe(50), { status: "timeout" });
  assert.equal(exec.execCalls, 1);
});

test("vaultNameProbe: an unrecognized (empty) reply → 'unrecognized' in exactly one attempt", async () => {
  const exec = new CountingExecutor({ stdout: "" });
  const d = new ObsidianDriver(exec);
  assert.deepEqual(await d.vaultNameProbe(50), { status: "unrecognized" });
  assert.equal(exec.execCalls, 1);
});

test("vaultNameProbe: a plain vault name is recognized in one attempt", async () => {
  const exec = new CountingExecutor({ stdout: "Throwaway" });
  const d = new ObsidianDriver(exec);
  assert.deepEqual(await d.vaultNameProbe(50), { status: "ok", name: "Throwaway" });
  assert.equal(exec.execCalls, 1);
});

test("snapshotFs: a killed shell reply → 'timeout' in exactly one attempt (no ~10min unresponsive retry)", async () => {
  const exec = new CountingExecutor({}, { killed: true });
  const d = new ObsidianDriver(exec, "/vault");
  const r = await d.snapshotFs("bughunt", 50);
  assert.deepEqual(r, { status: "timeout" });
  assert.equal(exec.shellCalls, 1);
  assert.equal(exec.lastShellTimeoutMs, 50);
});

test("snapshotFs: no vaultPath configured → 'unavailable', no call at all", async () => {
  const exec = new CountingExecutor();
  const d = new ObsidianDriver(exec); // no vaultPath
  assert.deepEqual(await d.snapshotFs("bughunt", 50), { status: "unavailable" });
  assert.equal(exec.shellCalls, 0);
});
