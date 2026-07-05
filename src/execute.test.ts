import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianDriver } from "./driver.js";
import { crossCheckFs, waitForSynced, runHistory } from "./execute.js";
import { CliInconsistencyError } from "./inconsistency.js";
import { sameConflictSet } from "./oracle.js";
import { parse } from "./dsl.js";
import { NoopIsolator } from "./isolate.js";
import type { RunLogger } from "./history.js";
import type { Executor } from "./exec.js";
import type { ExecResult } from "./types.js";

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
  const noLog = { log() {} } as unknown as RunLogger;
  const { observations, timedOut, unsynced } = await waitForSynced(
    [n1, n2], [NOTE], 0.08, // 80ms quiet window
    { noteName: (l) => l, pollSec: 0.02, minFloorSec: 0, probeSec: 0.03, capSec: 5 },
    noLog,
  );
  assert.equal(timedOut, false);
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
  const noLog = { log() {} } as unknown as RunLogger;
  const { observations, timedOut, unsynced } = await waitForSynced(
    [n1, n2], [NOTE], 0.05, // 50ms quiet window — plenty of polls fit inside the 150ms divergence
    { noteName: (l) => l, pollSec: 0.02, minFloorSec: 0, probeSec: 0.03, capSec: 5, hostCheck: false },
    noLog,
  );
  assert.equal(timedOut, false); // never gives up — see the settle's own doc comment
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
  constructor(readonly id: string, private readonly vault: Map<string, string>, private readonly syncStatus: (string | "killed") | (string | "killed")[] = "synced", private readonly startSynced = true) {}
  async exec(args: string[]): Promise<ExecResult> {
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
      case "sync:history": return this.vault.has(params.file) ? r("1") : notFound(params.file);
      case "files": return r([...this.vault.keys()].map((k) => `${k}.md`).join("\n"));
      case "read": return this.vault.has(params.file) ? r(this.vault.get(params.file)!) : notFound(params.file);
      case "create": {
        const file = params.path ? params.path.replace(/\.md$/, "") : params.name;
        this.vault.set(file, params.content ?? "");
        return r(`Created: ${file}`);
      }
      case "append": {
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

test("W only waits on the active node's own driver, not every online driver (final settle still waits on all of them)", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;

  await runHistory([n1, n2], new NoopIsolator(), logger, parse("AaW"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, wSettleSec: 0.02, finalSettleSec: 0.02, probeSec: 1,
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
  const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;

  await runHistory([n1, n2, local], new NoopIsolator(), logger, parse("AaWLAaW"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, wSettleSec: 0.02, finalSettleSec: 0.02, probeSec: 1,
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

test("the D/C defense-in-depth assert fires if a D op is forced through while the local instance is active (bypassing dsl.ts's normalize-time guarantee on purpose)", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault));
  const noLog = { log() {} } as unknown as RunLogger;
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
  const noLog = { log() {} } as unknown as RunLogger;
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
    const noLog = { log() {} } as unknown as RunLogger;
    await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1, hostCheck: false, wSettleSec: 0.02, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
    }); // resolves without throwing for every one of these states
  }
});

// --- the grace-retry regression: a blip that already ended by the time we checked -------------
// hostCheck is left ON (not false) for both of these — the exact path that had zero coverage
// before this fix, since waitForHostReconnect returns false immediately when hostOnline() is
// already true (the real, uncontrolled case in a test environment with real internet access).
test("assertLocalSyncOn: an off-state that recovers within the grace window does NOT abort, and flags hostOutage", async () => {
  const vault = new Map<string, string>();
  // startSynced:false — off from the very first read (as a real broken-from-rep-start local
  // instance would be); then recovers after two reads, well within localSyncGraceAttempts below.
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, ["error", "error", "synced"], false));
  const noLog = { log() {} } as unknown as RunLogger;
  const result = await runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
    noteName: (l) => `bughunt/${l}`, localNode: 1,
    localSyncGraceMs: 1, localSyncGraceAttempts: 2, // keep the grace window itself fast
    capSec: 1, wSettleSec: 0.02, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
  }); // must resolve, not throw — this is exactly the bug: it used to throw off the first "error" read
  assert.equal(result.timings.hostOutage, true, "a rep that needed grace retries should flag its timings as unreliable");
});

test("assertLocalSyncOn: an off-state that persists through every grace attempt still aborts", async () => {
  const vault = new Map<string, string>();
  const local = new ObsidianDriver(new SharedVaultExecutor("MyLocal", vault, "error", false));
  const noLog = { log() {} } as unknown as RunLogger;
  await assert.rejects(
    () => runHistory([local], new NoopIsolator(), noLog, [{ cmd: "local" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, localNode: 1,
      localSyncGraceMs: 1, localSyncGraceAttempts: 2,
    }),
    /local node's Sync is not on.*"error"/,
  );
});

// --- opt-in would-fail snapshot judgment (P and W) --------------------------------------
// A single-driver in-memory vault whose content "vanishes" (files/read start reporting
// not-found) after `vanishAtMs` — simulates an acked token going missing, observable at a LATER
// P/W snapshot. A single driver trivially "converges" with itself, so the final settle always
// completes normally regardless (no hang risk from Fix 1/2's unbounded/convergence-gated wait).
class VanishingExecutor implements Executor {
  id = "n1";
  private vault = new Map<string, string>();
  private start = Date.now();
  constructor(private readonly vanishAtMs: number) {}
  private elapsed() { return Date.now() - this.start; }
  private gone() { return this.elapsed() >= this.vanishAtMs; }
  async exec(args: string[]): Promise<ExecResult> {
    const r = (stdout: string): ExecResult => ({ argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false });
    const params = Object.fromEntries(args.slice(1).map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)];
    }));
    const notFound = (file: string) => r(`Error: File "${file}" not found.`);
    switch (args[0]) {
      case "sync:status": return r("status: synced");
      case "sync:history": return !this.gone() && this.vault.has(params.file) ? r("1") : notFound(params.file);
      case "files": return r(this.gone() ? "" : [...this.vault.keys()].map((k) => `${k}.md`).join("\n"));
      case "read": return !this.gone() && this.vault.has(params.file) ? r(this.vault.get(params.file)!) : notFound(params.file);
      case "create": {
        const file = params.path ? params.path.replace(/\.md$/, "") : params.name;
        this.vault.set(file, params.content ?? "");
        return r(`Created: ${file}`);
      }
      case "append": {
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

test("checkWouldFail: a P snapshot reports would-fail (LOST) when enabled, and writes WOULDFAIL.log", async () => {
  const tmpRunsDir = mkdtempSync(path.join(os.tmpdir(), "jepsen-wouldfail-"));
  try {
    const d = new ObsidianDriver(new VanishingExecutor(30));
    const events: Record<string, unknown>[] = [];
    const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
    await runHistory([d], new NoopIsolator(), logger, [{ cmd: "append", note: "a" }, { cmd: "pause", seconds: 0.1 }], {
      noteName: (l) => `bughunt/${l}`, wouldFailCheck: true, runsDir: tmpRunsDir,
      pollSec: 0.01, minFloorSec: 0, wSettleSec: 0.02, finalSettleSec: 0.02, hostCheck: false,
    });
    const wf = events.filter((e) => e.kind === "would-fail");
    assert.equal(wf.length, 1);
    assert.equal(wf[0].suffix, "-LOST");
  } finally {
    rmSync(tmpRunsDir, { recursive: true, force: true });
  }
});

test("checkWouldFail: a W also reports would-fail (LOST) when enabled", async () => {
  const tmpRunsDir = mkdtempSync(path.join(os.tmpdir(), "jepsen-wouldfail-"));
  try {
    const d = new ObsidianDriver(new VanishingExecutor(30));
    const events: Record<string, unknown>[] = [];
    const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
    await runHistory([d], new NoopIsolator(), logger, [{ cmd: "append", note: "a" }, { cmd: "pause", seconds: 0.1 }, { cmd: "wait" }], {
      noteName: (l) => `bughunt/${l}`, wouldFailCheck: true, runsDir: tmpRunsDir,
      pollSec: 0.01, minFloorSec: 0, wSettleSec: 0.02, finalSettleSec: 0.02, hostCheck: false,
    });
    const wf = events.filter((e) => e.kind === "would-fail");
    assert.ok(wf.length >= 1);
    assert.equal(wf[0].suffix, "-LOST");
  } finally {
    rmSync(tmpRunsDir, { recursive: true, force: true });
  }
});

test("checkWouldFail: off by default — no would-fail event even for the exact same vanishing content", async () => {
  const d = new ObsidianDriver(new VanishingExecutor(30));
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
  await runHistory([d], new NoopIsolator(), logger, [{ cmd: "append", note: "a" }, { cmd: "pause", seconds: 0.1 }], {
    noteName: (l) => `bughunt/${l}`, // wouldFailCheck not set — defaults off
    pollSec: 0.01, minFloorSec: 0, wSettleSec: 0.02, finalSettleSec: 0.02, hostCheck: false,
  });
  assert.equal(events.filter((e) => e.kind === "would-fail").length, 0);
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
    const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;
    await runHistory([n1, n2], new NoopIsolator(), logger, [
      { cmd: "node", node: 1 }, { cmd: "append", note: "a" },
      { cmd: "node", node: 2 }, { cmd: "append", note: "a" },
      { cmd: "pause", seconds: 0.02 }, // fires well before agreeAtMs — still disagreeing here
    ], {
      noteName: (l) => `bughunt/${l}`, wouldFailCheck: true, runsDir: tmpRunsDir,
      pollSec: 0.01, minFloorSec: 0, wSettleSec: 0.02, finalSettleSec: 0.02, hostCheck: false,
    });
    assert.equal(events.filter((e) => e.kind === "would-fail").length, 0);
  } finally {
    rmSync(tmpRunsDir, { recursive: true, force: true });
  }
});
