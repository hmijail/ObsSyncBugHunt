import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianDriver } from "./driver.js";
import { crossCheckFs, waitForSynced } from "./execute.js";
import { AlarmError } from "./alarm.js";
import { sameConflictSet } from "./oracle.js";
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
