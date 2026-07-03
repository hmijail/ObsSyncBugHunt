import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianDriver } from "./driver.js";
import { crossCheckFs, waitForSynced, runHistory } from "./execute.js";
import { AlarmError } from "./alarm.js";
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

test("crossCheckFs: CLI listing matches disk → no alarm", async () => {
  const d = driver("bughunt/a.md\nbughunt/b.md", "a.md\nb.md");
  await crossCheckFs([d], "bughunt"); // resolves without throwing
});

test("crossCheckFs: CLI reports a file the FS lacks → ALARM (phantom/never-written conflict file)", async () => {
  const d = driver("bughunt/a.md\nbughunt/a (Conflicted copy n2 202606261451).md", "a.md");
  await assert.rejects(() => crossCheckFs([d], "bughunt"), AlarmError);
});

test("crossCheckFs: FS has a file the CLI omits → ALARM (the 2026-06-26 dropout)", async () => {
  const d = driver("", "a.md\nb.md"); // CLI listing empty, disk non-empty
  await assert.rejects(() => crossCheckFs([d], "bughunt"), AlarmError);
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

// --- W's scope: the active node + active note only, not every online driver -------------
// A trivial always-synced fake CLI backed by a shared in-memory "vault" — both nodes read
// from the same Map, so content is always identical/converged. That makes timing/convergence
// uninteresting here; what's under test is which DRIVERS a mid-history `W` hands to
// waitForSynced, observable via the `states` array length on the settle-poll events it logs.
class SharedVaultExecutor implements Executor {
  // `syncStatus`: the word reported on `sync:status` from the SECOND call onward; "killed"
  // simulates a probe that never returns in time (syncStateProbe reports it as "timeout") rather
  // than a real status word. The FIRST call always reports "synced", satisfying runHistory's
  // baseline gate (waitNodesSynced) — both it and the mid-history bounded probe
  // (syncStateProbe/assertMacSyncOn) now go through the same per-attempt-timeout machinery, so
  // there's no longer a reliable opts-based signal to tell them apart (nor should there be — a
  // Mac that's really "paused" from the very start of a rep would fail the real baseline gate
  // too). Simulating "the Mac was fine at rep-start but became a problem mid-history" — exactly
  // what assertMacSyncOn exists to catch — needs the baseline gate to clear first either way.
  private syncStatusCalls = 0;
  constructor(readonly id: string, private readonly vault: Map<string, string>, private readonly syncStatus: string | "killed" = "synced") {}
  async exec(args: string[]): Promise<ExecResult> {
    const r = (stdout: string, killed = false): ExecResult => ({ argv: args, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed });
    const params = Object.fromEntries(args.slice(1).map((a) => {
      const i = a.indexOf("=");
      return i < 0 ? [a, ""] : [a.slice(0, i), a.slice(i + 1)];
    }));
    const notFound = (file: string) => r(`Error: File "${file}" not found.`);
    switch (args[0]) {
      case "sync:status":
        if (this.syncStatusCalls++ === 0) return r("status: synced");
        return this.syncStatus === "killed" ? r("", true) : r(`status: ${this.syncStatus}`);
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

// --- the Mac node: another ordinary driver, except D/C must never target it -------------
test("a Mac-backed third driver: W still scopes to 1, the final settle scopes to all 3", async () => {
  const vault = new Map<string, string>();
  const n1 = new ObsidianDriver(new SharedVaultExecutor("n1", vault));
  const n2 = new ObsidianDriver(new SharedVaultExecutor("n2", vault));
  const mac = new ObsidianDriver(new SharedVaultExecutor("MyMac", vault));
  const events: Record<string, unknown>[] = [];
  const logger = { log: (e: Record<string, unknown>) => events.push(e) } as unknown as RunLogger;

  await runHistory([n1, n2, mac], new NoopIsolator(), logger, parse("AaWMAaW"), {
    noteName: (l) => `bughunt/${l}`,
    pollSec: 0.01, minFloorSec: 0, capSec: 5, wSettleSec: 0.02, finalSettleSec: 0.02, probeSec: 1,
    hostCheck: false, macNode: 3,
  });

  const polls = events.filter((e) => e.kind === "settle-poll");
  const midWait = polls.filter((e) => "wait" in e);
  const final = polls.filter((e) => e.final === true);
  assert.ok(midWait.length > 0);
  assert.ok(final.length > 0);
  assert.ok(midWait.every((e) => (e.states as unknown[]).length === 1), "every mid-history W (numbered or Mac) probes only its own driver");
  assert.ok(final.every((e) => (e.states as unknown[]).length === 3), "the final settle probes all 3 drivers, including the Mac");
});

test("the D/C defense-in-depth assert fires if a D op is forced through while the Mac is active (bypassing dsl.ts's normalize-time guarantee on purpose)", async () => {
  const vault = new Map<string, string>();
  const mac = new ObsidianDriver(new SharedVaultExecutor("MyMac", vault));
  const noLog = { log() {} } as unknown as RunLogger;
  // A hand-built op array, never passed through dsl.ts's normalize()/assertMacAlwaysConnected
  // — proving the runtime assert in execute.ts is a real, independent second layer, not dead code.
  await assert.rejects(
    () => runHistory([mac], new NoopIsolator(), noLog, [{ cmd: "mac" }, { cmd: "disconnect" }], {
      noteName: (l) => `bughunt/${l}`, macNode: 1, hostCheck: false,
    }),
    /Mac node must never be disconnected/,
  );
});

// --- the Mac's Sync-on guard: abort (not just tag the rep) if it's ever found off -------------
test("assertMacSyncOn: a Mac whose Sync is paused aborts the whole run, not just the rep", async () => {
  const vault = new Map<string, string>();
  const mac = new ObsidianDriver(new SharedVaultExecutor("MyMac", vault, "paused"));
  const noLog = { log() {} } as unknown as RunLogger;
  // A plain Error (not AlarmError) — proving it escapes the per-rep catch in run.ts's runRep
  // rather than becoming a quiet -OBSFAIL, since a Mac with Sync off invalidates every
  // subsequent rep until a human fixes it. The baseline gate clears on SharedVaultExecutor's
  // always-"synced" first call, so the abort under test happens in the op loop as intended.
  await assert.rejects(
    () => runHistory([mac], new NoopIsolator(), noLog, [{ cmd: "mac" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, macNode: 1, hostCheck: false,
    }),
    /Mac's Sync is not on.*"paused"/,
  );
});

test("assertMacSyncOn: an inconclusive probe (syncing / timed-out / unreadable) is tolerated, not treated as off", async () => {
  for (const syncStatus of ["syncing", "killed" as const, "bogus-status-word"]) {
    const vault = new Map<string, string>();
    const mac = new ObsidianDriver(new SharedVaultExecutor("MyMac", vault, syncStatus));
    const noLog = { log() {} } as unknown as RunLogger;
    await runHistory([mac], new NoopIsolator(), noLog, [{ cmd: "mac" }, { cmd: "append", note: "a" }], {
      noteName: (l) => `bughunt/${l}`, macNode: 1, hostCheck: false, capSec: 1, wSettleSec: 0.02, finalSettleSec: 0.02, pollSec: 0.01, minFloorSec: 0,
    }); // resolves without throwing for every one of these states
  }
});
