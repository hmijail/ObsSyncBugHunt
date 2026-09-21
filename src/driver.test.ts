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
  lastExecArgv?: string[];
  constructor(private readonly execResult: Partial<ExecResult> = {}, private readonly shellResult: Partial<ExecResult> = {}) {}
  async exec(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.execCalls++;
    this.lastExecTimeoutMs = opts?.timeoutMs;
    this.lastExecArgv = args;
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
  // `raw` comes back too, and an EMPTY string is a real answer to carry: "it said nothing" and
  // "it said something we cannot parse" are different faults, and the log has to keep them apart.
  assert.deepEqual(await d.vaultNameProbe(50), { status: "unrecognized", raw: "" });
  assert.equal(exec.execCalls, 1);
});

test("every unrecognized snapshot reply carries the bytes that were not recognized", async () => {
  // "Could not parse it" is unactionable without the it. By the time anyone reads the log the call
  // is long gone, so the recognizer can only be taught from what was captured here.
  const GARBAGE = "Error: Sync is in error state. Check sync settings.";
  const d = new ObsidianDriver(new CountingExecutor({ stdout: GARBAGE }), "/vault");
  const got = [
    await d.snapshotVersionsTotal("bughunt/x", 50),
    await d.snapshotRead("bughunt/x", 50),
    await d.snapshotReadByPath("bughunt/x.md", 50),
    await d.vaultNameProbe(50),
  ];
  for (const r of got) {
    assert.equal(r.status, "unrecognized");
    assert.equal((r as { raw?: string }).raw, GARBAGE);
  }
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

// --- pinnedVault: opt-in vault= on content commands only ------------------------------------
test("pinnedVault: read carries a trailing vault= param when set, absent when unset", async () => {
  const withPin = new CountingExecutor({ stdout: "(n1-1-a)" });
  const d1 = new ObsidianDriver(withPin);
  d1.pinnedVault = "Throwaway";
  const r1 = await d1.read("bughunt/x");
  assert.ok(r1.raw.argv.includes("vault=Throwaway"), `expected vault= in argv: ${r1.raw.argv}`);

  const noPin = new CountingExecutor({ stdout: "(n1-1-a)" });
  const d2 = new ObsidianDriver(noPin);
  const r2 = await d2.read("bughunt/x");
  assert.ok(!r2.raw.argv.some((a) => a.startsWith("vault=")), `expected no vault= in argv: ${r2.raw.argv}`);
});

test("pinnedVault: appendLine (a mutation) carries vault= when set", async () => {
  const exec = new CountingExecutor({ stdout: "Appended to: bughunt/x" });
  const d = new ObsidianDriver(exec);
  d.pinnedVault = "Throwaway";
  const r = await d.appendLine("bughunt/x", "(n1-1-a)");
  assert.ok(r.raw.argv.includes("vault=Throwaway"));
});

test("pinnedVault: createNote carries vault= when set, for both the name= and path= shapes", async () => {
  const exec = new CountingExecutor({ stdout: "Created: bughunt/x" });
  const d = new ObsidianDriver(exec);
  d.pinnedVault = "Throwaway";
  const r = await d.createNote("bughunt/x", "(n1-1-a)");
  assert.ok(r.raw.argv.includes("vault=Throwaway"));
});

test("pinnedVault: listFiles carries vault= when set, with or without a folder", async () => {
  const exec = new CountingExecutor({ stdout: "" });
  const d = new ObsidianDriver(exec);
  d.pinnedVault = "Throwaway";
  const r = await d.listFiles("bughunt");
  assert.ok(r.raw.argv.includes("vault=Throwaway"));
});

test("pinnedVault: snapshotRead carries vault= when set", async () => {
  const exec = new CountingExecutor({ stdout: "(n1-1-a)" });
  const d = new ObsidianDriver(exec);
  d.pinnedVault = "Throwaway";
  await d.snapshotRead("bughunt/x", 50);
  assert.ok(exec.lastExecArgv?.includes("vault=Throwaway"), `expected vault= in argv: ${exec.lastExecArgv}`);
});

test("pinnedVault: sync:* commands never carry vault=, even when pinnedVault is set", async () => {
  const exec = new CountingExecutor({ stdout: "status: synced" });
  const d = new ObsidianDriver(exec);
  d.pinnedVault = "Throwaway";
  await d.syncStatus();
  assert.ok(!exec.lastExecArgv?.some((a) => a.startsWith("vault=")), `expected no vault= in argv: ${exec.lastExecArgv}`);
});

test("sampleNotes: a note that reads present but is missing from the listing is flagged, not trusted", () => {
  // The same cross-check the oracle-grade read makes (gatherObservation): when a listing omits a
  // note we just read, the two readings disagree — both arrived and parsed, and they cannot both be
  // right — and taking the listing at face value has fabricated a false "loss" before now
  // (docs/cli-trust.md). The sampler has both halves in one batch, so the check is free; unlike the
  // oracle path it must never throw, so it reports and the lane draws `!`.
  //
  // Pinned here as the CONTRACT rather than exercised through a stub executor: `inconsistent` must
  // be true exactly when the note read present and the usable listing lacks it.
  const cases = [
    { present: true, listingUsable: true, listed: [], expect: true },
    { present: true, listingUsable: true, listed: ["bughunt/a.md"], expect: false },
    { present: false, listingUsable: true, listed: [], expect: false }, // absent notes are not listed
    { present: true, listingUsable: false, listed: [], expect: false }, // unreadable listing decides nothing
  ];
  for (const c of cases) {
    const inconsistent = c.present && c.listingUsable && !c.listed.includes("bughunt/a.md");
    assert.equal(inconsistent, c.expect, JSON.stringify(c));
  }
});

test("conflictsOf / listingContradictsRead: one implementation, both read paths", () => {
  // These two predicates were duplicated in gatherObservation (oracle-grade) and sampleNotes
  // (bounded look). The paths differ in TRUST POLICY — how hard they try, and whether a
  // contradiction throws — but the interpretation is the same, so a fix here reaches both.
  const files = [
    "bughunt/a.md",
    "bughunt/a (Conflicted copy n2 202606211146).md",
    "bughunt/ab.md",                                    // a different note, not a conflict of `a`
    "bughunt/ab (Conflicted copy n1 202606211200).md",  // nor is its conflict copy
  ];
  assert.deepEqual(ObsidianDriver.conflictsOf(files, "bughunt/a"),
    ["bughunt/a (Conflicted copy n2 202606211146).md"]);

  const contradicts = ObsidianDriver.listingContradictsRead;
  assert.equal(contradicts(true, true, [], "bughunt/a"), true, "read present, listing lacks it");
  assert.equal(contradicts(true, true, files, "bughunt/a"), false);
  assert.equal(contradicts(false, true, [], "bughunt/a"), false, "an absent note is not listed");
  // An unreadable listing has NO OPINION. Treating it as a contradiction would invent evidence.
  assert.equal(contradicts(true, false, [], "bughunt/a"), false);
});

// --- the server counter riding along in the observation batch -----------------------------------
//
// `readWithListing` is the oracle-grade read on every settle poll of every rep. It optionally picks
// up `sync:history total` in the SAME exec, so a strategic run's timeline has a vers lane at all.
// What these pin down is that the extra can never cost the read anything.

/** Answers per COMMAND rather than per call index, so a test can say "sync:history is the one that
 *  blocks" without counting calls — which is what the interesting case is actually about. */
class ByCommandExecutor implements Executor {
  id = "n1";
  readonly seen: { cmd: string; timeoutMs?: number }[] = [];
  constructor(private readonly answers: Record<string, string | typeof KILLED>) {}
  async exec(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    this.seen.push({ cmd: args[0], timeoutMs: opts?.timeoutMs });
    const out = this.answers[args[0]] ?? "";
    const killed = out === KILLED;
    return { argv: ["podman", "exec", "n1", "obs", ...args], code: 0, stdout: killed ? "" : out, stderr: "", startedAt: "", durationMs: 0, killed };
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

const READ_A = "(tok)\n";
const LISTING_A = "bughunt/a.md\n";

test("readWithListing: no versionsMs asks for no counter at all — the old call, unchanged", async () => {
  const exec = new ByCommandExecutor({ read: READ_A, files: LISTING_A, "sync:history": "9" });
  const r = await new ObsidianDriver(exec).readWithListing("bughunt/a", "bughunt");
  assert.equal(r.versions, undefined, "not asked for, so not reported");
  assert.ok(!exec.seen.some((s) => s.cmd === "sync:history"), "and not even issued");
});

test("readWithListing: with versionsMs the counter comes back alongside the read", async () => {
  const exec = new ByCommandExecutor({ read: READ_A, files: LISTING_A, "sync:history": "7" });
  const r = await new ObsidianDriver(exec).readWithListing("bughunt/a", "bughunt", 500);
  assert.deepEqual(r.versions, { status: "ok", total: 7 });
  assert.equal(r.canonical, "(tok)", "the read is unaffected");
  assert.deepEqual(r.files, ["bughunt/a.md"]);
});

test("readWithListing: the counter is bounded by versionsMs, the read and listing are not", async () => {
  // The cap exists because `sync:history` BLOCKS on a node with no network (check-assumptions
  // step 7). Capping the read too would put the oracle's own call on a clock.
  const exec = new ByCommandExecutor({ read: READ_A, files: LISTING_A, "sync:history": "7" });
  await new ObsidianDriver(exec).readWithListing("bughunt/a", "bughunt", 250);
  const at = (cmd: string) => exec.seen.find((s) => s.cmd === cmd)?.timeoutMs;
  assert.equal(at("sync:history"), 250, "the counter carries its own cap");
  assert.notEqual(at("read"), 250, "the read keeps the recognize timeout, not the counter's");
});

test("readWithListing: a BLOCKED counter is reported as a timeout and costs the read nothing", async () => {
  // THE case this is all for. `D` is an ordinary op, and a disconnected node blocks `sync:history`.
  // Before the counter was made best-effort, a blocked one would have made the whole batch
  // unrecognized: the oracle-grade read retried on every settle poll of every history with a D in
  // it, and then threw.
  const exec = new ByCommandExecutor({ read: READ_A, files: LISTING_A, "sync:history": KILLED });
  const r = await new ObsidianDriver(exec).readWithListing("bughunt/a", "bughunt", 500);
  assert.deepEqual(r.versions, { status: "timeout" }, "blocked is a reading, not a failure");
  assert.equal(r.canonical, "(tok)", "the read still answered");
  assert.deepEqual(r.files, ["bughunt/a.md"]);
  // `timeout` and `unrecognized` must stay distinct: one says the node is busy syncing, which is
  // information, and the other says the CLI said something we cannot parse.
  const garbled = new ByCommandExecutor({ read: READ_A, files: LISTING_A, "sync:history": "not a number\n" });
  const g = await new ObsidianDriver(garbled).readWithListing("bughunt/a", "bughunt", 500);
  assert.deepEqual(g.versions, { status: "unrecognized" });
  assert.equal(g.canonical, "(tok)", "still costs the read nothing");
});

test("readWithListing: an unanswered READ still fails, counter or no counter", async () => {
  // The best-effort slot must not have relaxed the required ones. This is the contract the settle
  // depends on: a read it could not identify is never returned as if it were one. A KILLED read,
  // not a garbled one — `read` hands back the note's body, so almost any text is a valid reply and
  // there is nothing to garble.
  const exec = new ByCommandExecutor({ read: KILLED, files: LISTING_A, "sync:history": "7" });
  const d = new ObsidianDriver(exec);
  d.recognizeBackoffMs = 0; // no real waiting in the test
  await assert.rejects(() => d.readWithListing("bughunt/a", "bughunt", 500), CliUnrecognizedOutput);
});
