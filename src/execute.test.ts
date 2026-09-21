import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianDriver } from "./driver.js";
import { crossCheckFs, crossCheckContent, waitForSynced, runHistory } from "./execute.js";
import { CliInconsistencyError } from "./inconsistency.js";
import { sameConflictSet } from "./oracle.js";
import { parse } from "./dsl.js";
import { NoopIsolator } from "./isolate.js";
import { hostOnline } from "./net.js";
import type { RunLogger } from "./history.js";
import type { Executor } from "./exec.js";
import type { ExecResult } from "./types.js";

/** A RunLogger stub that keeps its events in memory — tests that don't inspect the log just let the
 *  array go unread. */
const stubLogger = (events: Record<string, unknown>[] = []) =>
  ({ log: (e: Record<string, unknown>) => events.push(e) }) as unknown as RunLogger;

// Stub that answers `files folder=…` (CLI listing) and `ls -1 …` (FS listing) from canned
// strings, so we can drive the CLI-vs-FS cross-check without a live node.
class StubExecutor implements Executor {
  id = "n1";
  constructor(private readonly cliFiles: string, private readonly lsOut: string, private readonly lsCode = 0) {}
  async exec(args: string[]): Promise<ExecResult> {
    const stdout = args[0] === "files" ? this.cliFiles : "";
    return { argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: this.lsCode, stdout: this.lsOut, stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}
const driver = (cli: string, ls: string, lsCode = 0) =>
  new ObsidianDriver(new StubExecutor(cli, ls, lsCode), "/vault");

test("crossCheckFs: CLI listing matches disk → no inconsistency", async () => {
  const d = driver("bughunt/a.md\nbughunt/b.md", "a.md\nb.md");
  await crossCheckFs([d], "bughunt"); // resolves without throwing
});

test("crossCheckFs: CLI reports a file the FS lacks → flagged inconsistency (phantom/never-written conflict file)", async () => {
  const d = driver("bughunt/a.md\nbughunt/a (Conflicted copy n2 202606261451).md", "a.md");
  await assert.rejects(() => crossCheckFs([d], "bughunt"), CliInconsistencyError);
});

test("crossCheckFs: FS has a file the CLI omits → flagged inconsistency (the 2026-06-26 dropout)", async () => {
  const d = driver("", "a.md\nb.md"); // CLI listing empty, disk non-empty
  await assert.rejects(() => crossCheckFs([d], "bughunt"), CliInconsistencyError);
});

// --- the CONTENT second source: `cat` must agree with obsidian-cli's `read` ------------------
// Stub whose CLI view and DISK view can be made to differ, so the check has something to catch.
class TwoViewExecutor implements Executor {
  constructor(readonly id: string, private readonly cliBody: string, private readonly diskBody: string | null) {}
  async exec(args: string[]): Promise<ExecResult> {
    const r = (stdout: string): ExecResult => ({ argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false });
    return r(args[0] === "read" ? this.cliBody : "");
  }
  async shell(argv: string[]): Promise<ExecResult> {
    const missing = this.diskBody === null;
    return { argv, code: missing ? 1 : 0, stdout: missing ? "" : this.diskBody!, stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}
const obs = (node: string, canonical: string | null, conflicts: { file: string; content: string }[] = []) =>
  ({ node, note: "bughunt/x", canonical, conflicts });

test("crossCheckContent: disk and CLI agree → no inconsistency", async () => {
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "(n1-1-a)"), "/vault");
  await crossCheckContent([d], [obs("n1", "(n1-1-a)")]);
});

test("crossCheckContent: a trailing newline is formatting, not a disagreement", async () => {
  // `read` returns the note without its final newline, `cat` returns the file. Comparing raw would
  // make this check fire on literally every note, which is the fastest way to get it turned off.
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "(n1-1-a)\n"), "/vault");
  await crossCheckContent([d], [obs("n1", "(n1-1-a)")]);
});

test("crossCheckContent: the CLI hiding a token that IS on disk is caught", async () => {
  // The failure this exists for: every `lost` verdict is obsidian-cli's word alone, so a `read`
  // that omits a token the file actually contains would be reported as data loss.
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "(n1-1-a)\n(n2-2-a)"), "/vault");
  await assert.rejects(() => crossCheckContent([d], [obs("n1", "(n1-1-a)")]), CliInconsistencyError);
});

test("crossCheckContent: a conflict copy's body is checked too, not just the note", async () => {
  // A token "preserved in a conflict file" is the difference between onlyInConflict and lost, so
  // that body carries as much weight as the canonical one.
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "(n1-1-a)"), "/vault");
  await assert.rejects(
    () => crossCheckContent([d], [obs("n1", "(n1-1-a)", [{ file: "bughunt/x (Conflicted copy n2 202609071550).md", content: "(n2-2-a)" }])]),
    CliInconsistencyError,
    "the conflict body read as (n2-2-a) but disk says (n1-1-a)",
  );
});

test("crossCheckContent: absent on both sides is the listing check's business, not this one", async () => {
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "", null), "/vault");
  await crossCheckContent([d], [obs("n1", null)]);
});

test("crossCheckContent: reports what it compared and what it cost, even when it agrees", async () => {
  // A check that reads two sources and says nothing unless it is unhappy leaves both its cost and
  // the fact that it ran at all invisible — and then a claim about its cost cannot be re-checked.
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "(n1-1-a)"), "/vault");
  const events: Record<string, unknown>[] = [];
  await crossCheckContent([d], [obs("n1", "(n1-1-a)")], stubLogger(events));
  const line = events.find((e) => e.kind === "cross-check");
  assert.ok(line, "the check logged a line despite finding nothing wrong");
  assert.equal(line.what, "content");
  assert.equal(line.files, 1);
  assert.equal(typeof line.ms, "number");
});

test("crossCheckContent: no vault path configured → skipped (no throw)", async () => {
  const d = new ObsidianDriver(new TwoViewExecutor("n1", "(n1-1-a)", "something else"));
  await crossCheckContent([d], [obs("n1", "(n1-1-a)")]);
});

test("crossCheckFs: no vault path configured → skipped (no throw)", async () => {
  const d = new ObsidianDriver(new StubExecutor("bughunt/a.md", "")); // no vaultPath
  await crossCheckFs([d], "bughunt");
});

// --- the settle regression guard for the false-SYNCBAD bug --------------------
// A node whose Sync is still working answers `sync:status` by BLOCKING (modeled here as a
// killed/timed-out exec → the bounded probe reads it "syncing"), and only later converges.
// A node that lags then catches up gains the conflict file partway through. The fix makes the
// settle POLL (bounded probe) and re-sample, so it must return the CONVERGED observation —
// before the fix it returned the single pre-convergence sample and mislabeled it -SYNCBAD.
const NOTE = "bughunt/x";
const CONFLICT = "bughunt/x (Conflicted copy n2 202606300000).md";
class ConvergingExecutor implements Executor {
  private start = Date.now();
  // `hasConflictAtMs`/`syncedAtMs`: when (since construction) this node gains the conflict
  // file and reports `synced`. A lagging node has a later `hasConflictAtMs`.
  constructor(readonly id: string, private readonly hasConflictAtMs: number, private readonly syncedAtMs: number) {}
  private elapsed() { return Date.now() - this.start; }
  async exec(args: string[], _opts?: { timeoutMs?: number }): Promise<ExecResult> {
    const r = (stdout: string, killed = false): ExecResult => ({ argv: ["podman", "exec", this.id, "obs", ...args], code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed });
    const cmd = args[0];
    if (cmd === "sync:status") return this.elapsed() < this.syncedAtMs ? r("", true) : r("status: synced");
    // `sync:history total` BLOCKS until the node is synced (modeled as killed while syncing). The
    // settle must therefore never read it before the bounded sync:status probe says synced — i.e.
    // the baseline read is lazy. If it regressed to an up-front read, this would stall the settle.
    if (cmd === "sync:history") return this.elapsed() < this.syncedAtMs ? r("", true) : r("3");
    if (cmd === "files") {
      const files = [`${NOTE}.md`];
      if (this.elapsed() >= this.hasConflictAtMs) files.push(CONFLICT);
      return r(files.join("\n"));
    }
    if (cmd === "read") {
      if (args[1]?.startsWith("path=")) return r("(op-n2-1)"); // conflict-file content
      return r("(op-n1-1)"); // canonical — identical on both nodes
    }
    return r("");
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("waitForSynced: converges while 'syncing' → returns the CONVERGED observation, not the stale pre-sync one", async () => {
  // n1 holds the conflict file from the start; n2 lags (gains it at 120ms). Both report
  // `synced` only at 120ms — so the early, divergent samples coincide with "syncing".
  const n1 = new ObsidianDriver(new ConvergingExecutor("n1", 0, 120));
  const n2 = new ObsidianDriver(new ConvergingExecutor("n2", 120, 120));
  const noLog = stubLogger();
  const { observations, unsynced } = await waitForSynced(
    [n1, n2], [NOTE], 0.08, // 80ms quiet window
    { noteName: (l) => l, pollSec: 0.02, minFloorSec: 0, probeSec: 0.03, capSec: 5 },
    noLog,
  );
  assert.equal(unsynced, false);
  // The returned snapshot must be the converged one: BOTH nodes hold the conflict file.
  const byNode = (n: string) => observations.find((o) => o.node === n)!;
  assert.ok(sameConflictSet(byNode("n1").conflicts, byNode("n2").conflicts), "both nodes' conflict sets agree at the settle");
  assert.equal(byNode("n2").conflicts.length, 1, "the lagging node caught up before the settle returned");
});

// --- the SYNCBAD-masks-LOST fix: a stable DISAGREEMENT must not finalize as "done" -------------
// Both nodes report `synced` the ENTIRE time (so `everySynced` is always true) but disagree on
// canonical content for a while — stable, so the OLD code (stability-only `done`) would have
// finalized immediately and mislabeled this -SYNCBAD. It only converges after `agreeAtMs`.
class DisagreeingExecutor implements Executor {
  private start = Date.now();
  constructor(readonly id: string, private readonly ownContent: string, private readonly agreedContent: string, private readonly agreeAtMs: number, private readonly note: string = NOTE) {}
  private elapsed() { return Date.now() - this.start; }
  async exec(args: string[]): Promise<ExecResult> {
    const r = (stdout: string): ExecResult => ({ argv: ["podman", "exec", this.id, "obs", ...args], code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false });
    const cmd = args[0];
    if (cmd === "sync:status") return r("status: synced"); // always synced — the whole point
    if (cmd === "sync:history") return r("3");
    if (cmd === "files") return r(`${this.note}.md`); // the note this driver's read() actually answers for
    if (cmd === "read") return r(this.elapsed() < this.agreeAtMs ? this.ownContent : this.agreedContent);
    return r("");
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("waitForSynced: a stable but DIVERGED state does not finalize as done — keeps polling until real convergence", async () => {
  const n1 = new ObsidianDriver(new DisagreeingExecutor("n1", "(n1-1-a)", "(agreed-a)", 150));
  const n2 = new ObsidianDriver(new DisagreeingExecutor("n2", "(n2-1-a)", "(agreed-a)", 150));
  const noLog = stubLogger();
  const { observations, unsynced } = await waitForSynced(
    [n1, n2], [NOTE], 0.05, // 50ms quiet window — plenty of polls fit inside the 150ms divergence
    { noteName: (l) => l, pollSec: 0.02, minFloorSec: 0, probeSec: 0.03, capSec: 5, hostCheck: false },
    noLog,
  );
  assert.equal(unsynced, false);
  const byNode = (n: string) => observations.find((o) => o.node === n)!;
  assert.equal(byNode("n1").canonical, "(agreed-a)", "waited past the stable disagreement for real convergence");
  assert.equal(byNode("n2").canonical, "(agreed-a)");
});

// --- W's scope: the active node + active note only, not every online driver -------------
// A trivial always-synced fake CLI backed by a shared in-memory "vault" — both nodes read
// from the same Map, so content is always identical/converged. That makes timing/convergence
// uninteresting here; what's under test is which DRIVERS a mid-history `W` hands to
// waitForSynced, observable via the `states` array length on the settle-poll events it logs.
class SharedVaultExecutor implements Executor {
  // `syncStatus`: the word(s) `sync:status` reports once `startSynced`'s grace period (if any)
  // has elapsed; "killed" simulates a probe that never returns in time (syncStateProbe reports it
  // as "timeout") rather than a real status word. A single value repeats forever; an array is
  // consumed one word per call (in order), holding at its last element once exhausted — for
  // simulating a driver that recovers after N reads. `startSynced` (default true) makes the FIRST
  // call report "synced" regardless of `syncStatus` — simulating "this driver was fine when the
  // rep started, then became a problem" (satisfies both runHistory's upfront local-Sync check and
  // its baseline gate cleanly, exactly like a real driver that hasn't broken yet). Pass `false`
  // for a driver that's already broken (or recovering) from the very first read — matching a real
  // local instance whose Sync is off (or was) when the rep starts, which runHistory's upfront
  // check must see directly, before ever reaching the baseline gate.
  private syncStatusCalls = 0;
  private vaultNameCalls = 0;
  constructor(readonly id: string, private readonly vault: Map<string, string>, private readonly syncStatus: (string | "killed") | (string | "killed")[] = "synced", private readonly startSynced = true, private readonly vaultName: (string | "killed") | (string | "killed")[] = "TestVault") {}
  /** Every command this node was asked to run, in order — so a test can assert on what the write
   *  path did NOT send, which is the only way to catch a round trip creeping back in. */
  readonly seen: string[][] = [];
  async exec(args: string[]): Promise<ExecResult> {
    this.seen.push(args);
    const r = (stdout: string, killed = false): ExecResult => ({ argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed });
    const params = Object.fromEntries(args.slice(1).map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)];
    }));
    const notFound = (file: string) => r(`Error: File "${file}" not found.`);
    switch (args[0]) {
      case "sync:status": {
        const n = this.syncStatusCalls++;
        if (this.startSynced && n === 0) return r("status: synced");
        const seq = Array.isArray(this.syncStatus) ? this.syncStatus : [this.syncStatus];
        const i = this.startSynced ? n - 1 : n;
        const word = seq[Math.min(i, seq.length - 1)];
        return word === "killed" ? r("", true) : r(`status: ${word}`);
      }
      // One server version per line of content. It used to answer a constant "1", which made every
      // edit after a note's first look like an upload that never left — the token-aware `W` waits
      // for this counter to move past its pre-write value, so a constant hangs it forever.
      case "sync:history":
        return this.vault.has(params.file)
          ? r(String((this.vault.get(params.file) ?? "").split("\n").filter(Boolean).length))
          : notFound(params.file);
      case "files": return r([...this.vault.keys()].map((k) => `${k}.md`).join("\n"));
      case "read": return this.vault.has(params.file) ? r(this.vault.get(params.file)!) : notFound(params.file);
      case "create": {
        const file = params.path ? params.path.replace(/\.md$/, "") : params.name;
        this.vault.set(file, params.content ?? "");
        return r(`Created: ${file}`);
      }
      case "append": {
        // Appending to a note this node does not have is an ERROR, not a silent create. Measured
        // against obsidian-cli 1.13.7 on 2026-09-06: `Error: File "..." not found.` The stub used to
        // create it, which quietly made the create path untestable — the executor never returned the
        // reply the real one does, so nothing ever took the branch that handles it.
        if (!this.vault.has(params.file)) return notFound(params.file);
        const prev = this.vault.get(params.file) ?? "";
        this.vault.set(params.file, prev ? `${prev}\n${params.content}` : params.content);
        return r(`Appended to: ${params.file}`);
      }
      case "open": return r(`Opened: ${params.file}`);
      case "vault": {
        if (params.info !== "name") return r("");
        const seq = Array.isArray(this.vaultName) ? this.vaultName : [this.vaultName];
        const word = seq[Math.min(this.vaultNameCalls++, seq.length - 1)];
        return word === "killed" ? r("", true) : r(word);
      }
      default: return r("");
    }
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("append: a note's first write CREATES it, later writes append, and neither duplicates", async () => {
  // The write path tries `append` first and falls back to `create` only when the CLI positively
  // reports the note missing. Deliberately that order: `create` on an existing note neither fails
  // nor overwrites — the real CLI silently makes a numbered sibling (`<note> 1.md`), a file the
  // oracle never accounted for. Guessing wrong toward `append` costs a round trip and nothing else.
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const events: Record<string, unknown>[] = [];
  await runHistory([n1], new NoopIsolator(), stubLogger(events), parse("AaP1Aa"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1, hostCheck: false,
  });
  const appended = events.filter((e) => e.kind === "appended");
  assert.equal(appended.length, 2);
  assert.equal(appended[0].created, true, "the first write had to create the note");
  assert.equal(appended[1].created, false, "the second appended to the note that now exists");
  // Both tokens survive, each exactly once: an append retried over a create would double one.
  const body = vault.get("bughunt/a") ?? "";
  for (const e of appended) {
    assert.equal(body.split(e.token as string).length - 1, 1, `${e.token as string} appears exactly once`);
  }
});

test("a note's genesis write goes straight to create — no doomed append, no baseline read", async () => {
  // The write path normally probes with `append` and creates only on a positive "not found". At a
  // note's GENESIS that probe is not a probe: nothing has written the note anywhere, so the reply is
  // already known. Both round trips it would cost land between the two appends of a history like
  // `N1AaN2Aa`, which is exactly where the harness must not be.
  const vault = new Map<string, string>();
  const ex = new SharedVaultExecutor("n1", vault);
  const events: Record<string, unknown>[] = [];
  await runHistory([new ObsidianDriver(ex)], new NoopIsolator(), stubLogger(events), parse("Aa"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1, hostCheck: false,
  });
  const upTo = ex.seen.findIndex((a) => a[0] === "create");
  assert.ok(upTo >= 0, "the note was created");
  const before = ex.seen.slice(0, upTo).map((a) => a[0]);
  assert.ok(!before.includes("append"), `no append was attempted before the create, got ${before.join(",")}`);
  assert.ok(!before.includes("sync:history"), `no counter was read before the create, got ${before.join(",")}`);
  // The baseline is still RECORDED, just derived rather than measured — the timeline's `vers` lane
  // has to start at the note's genesis, which is the whole reason these samples are logged.
  const genesis = events.filter((e) => e.kind === "sample" && e.baseline === true);
  assert.equal(genesis.length, 1);
  assert.equal(genesis[0].inferred, true);
  assert.equal(genesis[0].versStatus, "absent", "no node can hold server history for a note nothing has written");
});

test("a node's counter baseline is refreshed by its OWN append and by nobody else's", async () => {
  // A baseline is "the counter before the write THIS node is waiting to see confirmed", not "the
  // counter lately". Re-reading it when a different node appends could only replace a correct
  // pre-write value with one that may already count the write — and it used to cost ~230ms sitting
  // between two appends that were supposed to race.
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const events: Record<string, unknown>[] = [];
  // `P1` only because the duration floor charges 0.1s per append and an instant stub cannot pay it;
  // two appends by the same node is the shape being tested.
  await runHistory([n1, n2], new NoopIsolator(), stubLogger(events), parse("AaP1Aa"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1, hostCheck: false,
  });
  // One group per append, in order: genesis names every node at once, then the writer names only
  // itself. An `n2` in third place would mean a node re-read a baseline it already held — the
  // ~230ms that used to sit between two appends meant to race.
  const baselines = events.filter((e) => e.kind === "sample" && e.baseline === true);
  assert.equal(events.filter((e) => e.kind === "appended").length, 2);
  assert.deepEqual(
    baselines.map((e) => `${e.node as string}${e.inferred === true ? "*" : ""}`),
    ["n1*", "n2*", "n1"],
    "genesis infers both nodes; n1's second append reads only n1's own counter",
  );
});

test("a look that did not answer does not make the next one report a change", async () => {
  // The 08T171228 shape: `M` marks scattered through a partition, always right after an `x`. A
  // timed-out sample used to CLEAR the remembered content, so the next successful read compared
  // against nothing and reported a change that never happened — 15 of that rep's 16 `changed`
  // marks were this. `CounterLane` had the rule already ("a non-answer does not disturb the
  // remembered value"); the file lane did not.
  const vault = new Map<string, string>();
  // `syncStatus` sequence drives the settle: killed probes make the sampler's own calls time out.
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault, ["killed", "killed", "synced"]));
  const events: Record<string, unknown>[] = [];
  await runHistory([n1], new NoopIsolator(), stubLogger(events), parse("AaP1"), {
    noteName: (l) => `bughunt/${l}`, sampling: "everything",
    pollSec: 0.05, minFloorSec: 0, capSec: 5, finalSettleSec: 0.3, probeSec: 1, hostCheck: false,
  });
  const looks = events.filter((e) => e.kind === "sample" && e.fileStatus !== undefined);
  // Walk the samples in order: a `changed` may never sit immediately after a non-answer.
  let prev: string | undefined;
  for (const e of looks) {
    if (prev !== undefined && prev !== "present" && prev !== "absent") {
      assert.notEqual(e.changed, true, `a change was reported straight after a "${prev}" look`);
    }
    prev = e.fileStatus as string;
  }
  // And a look that could not answer must not claim the token is missing either.
  for (const e of looks) {
    if (e.fileStatus !== "present" && e.fileStatus !== "absent") {
      assert.equal(e.lost, null, "an unanswered look reports `lost: null`, not a verdict");
    }
  }
});

test("a pause is sampled throughout under `everything`, and is not shortened by it", async () => {
  // The pause used to be one uninterrupted sleep, so the most informative stretch of a D...P...C
  // rep — where propagation actually happens — was the one stretch nothing watched.
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const events: Record<string, unknown>[] = [];
  const t0 = Date.now();
  await runHistory([n1, n2], new NoopIsolator(), stubLogger(events), parse("AaP1"), {
    noteName: (l) => `bughunt/${l}`, sampling: "everything",
    pollSec: 0.05, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1, hostCheck: false,
  });
  const elapsed = Date.now() - t0;
  // Bracketed by the pause's own events, so the final settle's samples cannot be mistaken for these.
  const at = (kind: string) => events.findIndex((e) => e.kind === kind);
  const during = events.slice(at("pausing"), at("pause-snapshot"))
    .filter((e) => e.kind === "sample" && e.fileStatus !== undefined);
  assert.ok(during.length >= 2, `the pause was sampled more than once, got ${during.length}`);
  assert.ok(during.some((e) => e.node === "n1") && during.some((e) => e.node === "n2"),
    "every node is sampled, not just the one holding the cursor");
  // The pause must never come out SHORTER than asked — that would change the experiment and is
  // exactly what a sampling loop bounded on round COUNT rather than wall clock would do.
  assert.ok(elapsed >= 1000, `the P1 pause still lasted at least its second, took ${elapsed}ms`);
});

test("a pause is not sampled in strategic mode", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const events: Record<string, unknown>[] = [];
  await runHistory([n1], new NoopIsolator(), stubLogger(events), parse("AaP1"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.05, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1, hostCheck: false,
  });
  const at = (kind: string) => events.findIndex((e) => e.kind === kind);
  const during = events.slice(at("pausing"), at("pause-snapshot"))
    .filter((e) => e.kind === "sample");
  assert.deepEqual(during, [], "the default mode leaves the pause alone");
});

test("W only waits on the active node's own driver, not every online driver (final settle still waits on all of them)", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);

  await runHistory([n1, n2], new NoopIsolator(), logger, parse("AaW"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1,
    hostCheck: false,
  });

  const polls = events.filter((e) => e.kind === "settle-poll");
  const midWait = polls.filter((e) => "wait" in e);
  const final = polls.filter((e) => e.final === true);
  assert.ok(midWait.length > 0, "the mid-history W logged at least one settle-poll");
  assert.ok(final.length > 0, "the final settle logged at least one settle-poll");
  assert.ok(midWait.every((e) => (e.states as unknown[]).length === 1), "W only probed the active node's own driver");
  assert.ok(final.every((e) => (e.states as unknown[]).length === 2), "the final settle probed every driver");
});

// --- the local node: another ordinary driver, except D/C must never target it -------------
test("a local-instance-backed third driver: W still scopes to 1, the final settle scopes to all 3", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);

  await runHistory([n1, n2, local], new NoopIsolator(), logger, parse("AaWLAaW"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, finalSettleSec: 0.02, probeSec: 1,
    hostCheck: false, localNode: 3,
  });

  const polls = events.filter((e) => e.kind === "settle-poll");
  const midWait = polls.filter((e) => "wait" in e);
  const final = polls.filter((e) => e.final === true);
  assert.ok(midWait.length > 0);
  assert.ok(final.length > 0);
  assert.ok(midWait.every((e) => (e.states as unknown[]).length === 1), "every mid-history W (numbered or local) probes only its own driver");
  assert.ok(final.every((e) => (e.states as unknown[]).length === 3), "the final settle probes all 3 drivers, including the local instance");
});

// --- driverOf resolves N<d> by container NAME, not array position -------------------------
test("driverOf resolves N<d> by container name, not array position (the NODES=l,n2 crash scenario)", async () => {
  const vault = new Map<string, string>();
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);
  // drivers = [n2, local] — only ONE container, at array position 1; local at position 2.
  // Before this fix, N2 would have positionally resolved to drivers[1] = local (the real bug
  // that crashed a live soak). It must now resolve to the container actually named "n2".
  await runHistory([n2, local], new NoopIsolator(), logger, parse("N2AaLAa"), {
    noteName: (l) => `bughunt/${l}`, localNode: 2, hostCheck: false,
    pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02,
  });
  const appended = events.filter((e) => e.kind === "appended");
  assert.equal(appended.length, 2);
  assert.equal(appended[0].node, "n2", "N2 must append via the container named n2, not local");
  assert.equal(appended[1].node, "MyLocal", "L must append via the local driver");
});

test("N<d> with no matching configured container throws a clear error naming what's missing", async () => {
  const vault = new Map<string, string>();
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const noLog = stubLogger();
  await assert.rejects(
    () => runHistory([n2], new NoopIsolator(), noLog, parse("N1Aa"), {
      noteName: (l) => `bughunt/${l}`, hostCheck: false,
    }),
    /N1 has no matching container/,
  );
});

test("driverOf is order-independent: N1/N2 resolve correctly even when drivers are constructed out of order", async () => {
  const vault = new Map<string, string>();
  // Deliberately swapped: n2 passed before n1.
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);
  await runHistory([n2, n1], new NoopIsolator(), logger, parse("N1AaN2Aa"), {
    noteName: (l) => `bughunt/${l}`, hostCheck: false,
    pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02,
  });
  const appended = events.filter((e) => e.kind === "appended");
  assert.equal(appended.length, 2);
  assert.equal(appended[0].node, "n1", "N1 must resolve to container n1 regardless of array order");
  assert.equal(appended[1].node, "n2", "N2 must resolve to container n2 regardless of array order");
});

// --- opts.snapshot: skip the whole pause-snapshot mechanism, not just its timing fields -----
test("opts.snapshot: false skips the whole pause-snapshot mechanism — no event logged", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);
  await runHistory([n1], new NoopIsolator(), logger, parse("AaP1"), {
    noteName: (l) => `bughunt/${l}`, hostCheck: false, snapshot: false,
    pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02,
  });
  assert.equal(events.filter((e) => e.kind === "pause-snapshot").length, 0);
});

test("pause-snapshot is logged by default (opts.snapshot unset)", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);
  await runHistory([n1], new NoopIsolator(), logger, parse("AaP1"), {
    noteName: (l) => `bughunt/${l}`, hostCheck: false,
    pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02,
  });
  assert.equal(events.filter((e) => e.kind === "pause-snapshot").length, 1);
});

test("the D/C defense-in-depth assert fires if a D op is forced through while the local instance is active (bypassing dsl.ts's normalize-time guarantee on purpose)", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault));
  const noLog = stubLogger();
  // A hand-built op array, never passed through dsl.ts's normalize()/assertLocalAlwaysConnected
  // — proving the runtime assert in execute.ts is a real, independent second layer, not dead code.
  await assert.rejects(
    () => runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "disconnect" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false,
    }),
    /local node must never be disconnected/,
  );
});

// --- the local instance's Sync-on guard: abort (not just tag the rep) if it's ever found off ---
test("assertLocalSyncOn: a local instance whose Sync is paused aborts the whole run, not just the rep", async () => {
  const vault = new Map<string, string>();
  // startSynced:false — this driver is broken from the very first read, matching a real always-
  // off local instance (e.g. the wrong vault frontmost): runHistory's upfront local-Sync check
  // must catch this on its very first probe, before ever reaching the baseline gate.
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "paused", false));
  const noLog = stubLogger();
  // A plain Error (not CliInconsistencyError) — proving it escapes the per-rep catch in run.ts's runRep
  // rather than becoming a quiet -OBSFAIL, since the local instance's Sync being off invalidates
  // every subsequent rep until a human fixes it. hostCheck:false disables the host-outage detour,
  // so this still aborts immediately, same as before that detour existed. The abort now happens
  // in runHistory's upfront check, before the op loop even starts.
  await assert.rejects(
    () => runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false,
    }),
    /local node's Sync is not on.*"paused"/,
  );
});

test("assertLocalSyncOn: an inconclusive probe (syncing / timed-out / unreadable) is tolerated, not treated as off", async () => {
  for (const value of ["syncing", "killed" as const, "bogus-status-word"]) {
    const vault = new Map<string, string>();
    // Sequenced, not constant: "synced" (satisfies waitNodesSynced's own poll), then the
    // inconclusive value ONCE (assertLocalSyncOn's append-triggered probe must tolerate it, not
    // treat it as off), then back to "synced" (so the final settle — now unbounded, no give-up —
    // actually completes; a driver that never resolves would hang forever by design, which is
    // correct in production but untestable here).
    const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, ["synced", value, "synced"], true));
    const noLog = stubLogger();
    await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
    }); // resolves without throwing for every one of these states
  }
});

// --- the grace-retry regression: a blip that already ended by the time we checked -------------
// hostCheck is left ON (not false) for both of these — the exact path that had zero coverage
// before this fix, since waitForHostReconnect returns false immediately when hostOnline() is
// already true (the real, uncontrolled case in a test environment with real internet access).
//
// That "real internet access" is a genuine PRECONDITION of these two tests, not an incidental
// detail, and it is the only one in the suite: every other test here is hermetic. Without it,
// waitForHostReconnect's retry loop (execute.ts) is deliberately UNBOUNDED — correct for a real
// soak, which should wait out a real outage, but in a test it means `make test` hangs forever
// with no output and no clue which of 15 files is stuck. Checked up front so the precondition
// fails LOUDLY and in ~ms instead. The runtime's own answer to this state is `--skip-host-check`
// (see run.ts, which aborts with the same diagnosis rather than wedging); this is its equivalent
// for the test suite.
//
// Short timeoutMs on purpose: the default 4s is the right budget for a mid-soak probe deciding
// whether to blame Sync, but here we only want a fast verdict. A network that DROPS (rather than
// refuses) packets pays this timeout once per test; a refused connect answers in ~1ms.
const requireHostOnline = async () => {
  if (await hostOnline(undefined, undefined, 2000)) return;
  assert.fail(
    "this test needs real outbound TCP to 8.8.8.8:53 and the host cannot reach it — it exercises " +
    "waitForHostReconnect's grace-retry path with hostCheck ON, whose retry loop is unbounded by " +
    "design. Skipped-by-failing rather than hung. Re-run with connectivity (the rest of the suite " +
    "is hermetic and passes offline).",
  );
};

test("assertLocalSyncOn: an off-state that recovers within the grace window does NOT abort, and flags hostOutage", async () => {
  await requireHostOnline();
  const vault = new Map<string, string>();
  // startSynced:false — off from the very first read (as a real broken-from-rep-start local
  // instance would be); then recovers after two reads, well within localSyncGraceAttempts below.
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, ["error", "error", "synced"], false));
  const noLog = stubLogger();
  const result = await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1,
    localSyncGraceMs: 1, localSyncGraceAttempts: 2, // keep the grace window itself fast
    capSec: 1, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // must resolve, not throw — this is exactly the bug: it used to throw off the first "error" read
  assert.equal(result.timings.hostOutage, true, "a rep that needed grace retries should flag its timings as unreliable");
});

test("assertLocalSyncOn: an off-state that persists through every grace attempt still aborts", async () => {
  await requireHostOnline();
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "error", false));
  const noLog = stubLogger();
  await assert.rejects(
    () => runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1,
      localSyncGraceMs: 1, localSyncGraceAttempts: 2,
    }),
    /local node's Sync is not on.*"error"/,
  );
});

// --- the local instance's active-vault guard: wait for it to come back, never abort ---
test("assertLocalVaultUnchanged: the captured name still matching the driver's own report never throws", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "synced", true, "Throwaway"));
  const noLog = stubLogger();
  await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, localVaultName: "Throwaway", finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // must resolve, not throw
});

test("assertLocalVaultUnchanged: a changed vault name is waited out, not aborted on, and flags vaultDrift", async () => {
  const vault = new Map<string, string>();
  // Wrong at the rep's upfront check, still wrong on the first recheck, matches on the second —
  // proves this actually POLLS (not just re-reads once) before giving up on aborting altogether.
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "synced", true, ["SomeOtherVault", "SomeOtherVault", "Throwaway"]));
  const events: Record<string, unknown>[] = [];
  const logger = stubLogger(events);
  const result = await runHistory([local], new NoopIsolator(), logger, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, localVaultName: "Throwaway",
    vaultRecheckMs: 1, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // must resolve, not throw — the whole point of this round's change
  assert.equal(result.timings.vaultDrift, true);
  assert.equal(events.filter((e) => e.kind === "local-vault-changed").length, 1);
  assert.ok(events.some((e) => e.kind === "local-vault-recheck" && e.back === false), "at least one recheck still saw the wrong vault");
  assert.ok(events.some((e) => e.kind === "local-vault-recheck" && e.back === true), "a later recheck confirmed it came back");
  assert.equal(events.filter((e) => e.kind === "local-vault-restored").length, 1);
});

test("assertLocalVaultUnchanged: no captured baseline (localVaultName unset) means the check never fires", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "synced", true, "WhateverIsActive"));
  const noLog = stubLogger();
  await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // no localVaultName in opts → never checked, never throws regardless of the driver's report
});

test("assertLocalVaultUnchanged: an inconclusive probe (killed) is tolerated, not treated as a mismatch", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "synced", true, "killed"));
  const noLog = stubLogger();
  await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, localVaultName: "Throwaway", finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // a killed vault-name probe must never itself manufacture a failure
});

test("checkWouldFail: a stable node-vs-node DISAGREEMENT (SYNCBAD-shaped) is never reported, even when enabled", async () => {
  const tmpRunsDir = mkdtempSync(path.join(os.tmpdir(), "jepsen-wouldfail-"));
  try {
    // Each node holds only its OWN token until agreeAtMs — nothing is missing everywhere (not
    // LOST) and nothing repeats (not DUPL); the two disagree, which is exactly the shape
    // checkWouldFail must ignore. agreeAtMs is set well AFTER the pause's would-fail check but
    // still short, so the final settle (which requires real convergence — Fix 2) completes
    // normally instead of racing/abandoning a genuinely unbounded wait. Tokens match exactly
    // what execute.ts's real append loop will compute (formatToken's `seq` is a GLOBAL counter
    // across the whole history, not per-node — n1's append is seq 1, n2's is seq 2 — so `read()`
    // already "sees" the right token from its very first check and never needs create/append to
    // do anything real).
    // Agreed content keeps BOTH real tokens (merged) — the final verdict must be a clean PASS
    // once converged, not a real LOST (which would trigger lostForensics' own server-history
    // reads, unmodeled by this stub and irrelevant to what this test is actually checking).
    const agreed = "(n1-1-a)\n(n2-2-a)";
    const n1 = new ObsidianDriver(new DisagreeingExecutor("n1", "(n1-1-a)", agreed, 150, "bughunt/a"));
    const n2 = new ObsidianDriver(new DisagreeingExecutor("n2", "(n2-2-a)", agreed, 150, "bughunt/a"));
    const events: Record<string, unknown>[] = [];
    const logger = stubLogger(events);
    await runHistory([n1, n2], new NoopIsolator(), logger, [
      { cmd: "node", node: 1 }, { cmd: "append", note: "a" },
      { cmd: "node", node: 2 }, { cmd: "append", note: "a" },
      { cmd: "pause", seconds: 0.02 }, // fires well before agreeAtMs — still disagreeing here
    ], {
      noteName: (l) => `bughunt/${l}`, runsDir: tmpRunsDir,
      pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02, hostCheck: false,
    });
    assert.equal(events.filter((e) => e.kind === "would-fail").length, 0);
  } finally {
    rmSync(tmpRunsDir, { recursive: true, force: true });
  }
});

// --- lostForensics: writer attribution + conflictFileFound --------------------------------
// Like VanishingExecutor (a lone driver trivially converges with itself, so the final settle
// completes regardless of Round 9's convergence requirement), except sync:history/sync:read
// (the SERVER-side truth lostForensics queries) always reflect the vault regardless of `gone()`,
// while files/read (the CLIENT-facing view) go empty once gone — modeling "the server still has
// it in history, but the local client no longer shows it as current". Optionally also serves a
// "(Conflicted copy n1 <ts>)" file once gone, to control conflictFileFound independently.
class LostForensicExecutor implements Executor {
  id = "n1";
  private vault = new Map<string, string>();
  private start = Date.now();
  constructor(private readonly vanishAtMs: number, private readonly conflictContent: string | null) {}
  private elapsed() { return Date.now() - this.start; }
  private gone() { return this.elapsed() >= this.vanishAtMs; }
  async exec(args: string[]): Promise<ExecResult> {
    const r = (stdout: string): ExecResult => ({ argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false });
    const params = Object.fromEntries(args.slice(1).map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)];
    }));
    const notFound = (file: string) => r(`Error: File "${file}" not found.`);
    const CONFLICT = "bughunt/a (Conflicted copy n1 202607091600).md"; // must match the actual note (letter "a")
    switch (args[0]) {
      case "sync:status": return r("status: synced");
      case "sync:history": return this.vault.has(params.file) ? r("1") : notFound(params.file);
      case "sync:read": return this.vault.has(params.file) ? r(`${params.file} (version 0, 2026-07-09 16:00:00)\n---\n${this.vault.get(params.file)}`) : notFound(params.file);
      case "files": {
        const names = this.gone() ? [] : [...this.vault.keys()].map((k) => `${k}.md`);
        if (this.gone() && this.conflictContent !== null) names.push(CONFLICT);
        return r(names.join("\n"));
      }
      case "read": {
        if (params.path === CONFLICT && this.conflictContent !== null) return r(this.conflictContent);
        if (!this.gone() && this.vault.has(params.file)) return r(this.vault.get(params.file)!);
        return notFound(params.file ?? params.path);
      }
      case "create": {
        const file = params.path ? params.path.replace(/\.md$/, "") : params.name;
        this.vault.set(file, params.content ?? "");
        return r(`Created: ${file}`);
      }
      case "append": {
        // Appending to a note this node does not have is an ERROR, not a silent create. Measured
        // against obsidian-cli 1.13.7 on 2026-09-06: `Error: File "..." not found.` The stub used to
        // create it, which quietly made the create path untestable — the executor never returned the
        // reply the real one does, so nothing ever took the branch that handles it.
        if (!this.vault.has(params.file)) return notFound(params.file);
        const prev = this.vault.get(params.file) ?? "";
        this.vault.set(params.file, prev ? `${prev}\n${params.content}` : params.content);
        return r(`Appended to: ${params.file}`);
      }
      case "open": return r(`Opened: ${params.file}`);
      default: return r("");
    }
  }
  async shell(argv: string[]): Promise<ExecResult> {
    return { argv, code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
}

test("lostForensics: writer is attributed from AckedEdit, and conflictFileFound reflects whether the writer's device left ANY conflict file for the note (not necessarily containing the lost token itself)", async () => {
  for (const conflictContent of ["(n1-0-x)", null]) {
    const n1 = new ObsidianDriver(new LostForensicExecutor(15, conflictContent));
    const events: Record<string, unknown>[] = [];
    const logger = stubLogger(events);
    // A pause before the final settle, well past vanishAtMs, guarantees the settle observes it
    // already gone (mirrors the checkWouldFail/VanishingExecutor tests' own timing pattern).
    const result = await runHistory([n1], new NoopIsolator(), logger, [{ cmd: "append", note: "a" }, { cmd: "pause", seconds: 0.05 }], {
      noteName: (l) => `bughunt/${l}`, hostCheck: false,
      pollSec: 0.01, minFloorSec: 0, finalSettleSec: 0.02,
    });
    assert.equal(result.verdict.notes[0].lost.length, 1, "the token really did vanish — a genuine LOST");
    assert.equal(result.forensics.length, 1);
    const f = result.forensics[0];
    assert.equal(f.writer, "n1", "attributed from acked, not guessed");
    assert.equal(f.inServer, true, "the server-side history still has it — this isn't testing that path");
    assert.equal(f.conflictFileFound, conflictContent !== null, `conflictContent=${conflictContent}`);
  }
});
