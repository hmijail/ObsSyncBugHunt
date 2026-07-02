import test from "node:test";
import assert from "node:assert/strict";
import { ObsidianDriver } from "./driver.js";
import { gatherObservation } from "./runner.js";
import { AlarmError } from "./alarm.js";
import type { Executor } from "./exec.js";
import type { ExecResult } from "./types.js";

// Stub executor: maps `read file=X` and `files` to canned stdout so we can exercise the
// driver's recognizers and the gatherObservation anchor without a live node.
class StubExecutor implements Executor {
  id = "n1";
  constructor(private readonly handler: (args: string[]) => string) {}
  private result(args: string[]): ExecResult {
    return { argv: args, code: 0, stdout: this.handler(args), stderr: "", startedAt: "", durationMs: 0, killed: false };
  }
  async exec(args: string[]) { return this.result(args); }
  async shell(argv: string[]) { return this.result(argv); }
}

const NOTE = "bughunt/x";

test("gatherObservation: consistent read+listing → observation, no alarm", async () => {
  const d = new ObsidianDriver(new StubExecutor((args) => {
    if (args[0] === "read") return "(op-n1-1)";
    if (args[0] === "files") return `${NOTE}.md\nbughunt/other.md`;
    return "";
  }));
  const obs = await gatherObservation(d, NOTE);
  assert.equal(obs.canonical, "(op-n1-1)");
  assert.deepEqual(obs.conflicts, []);
});

test("gatherObservation: note reads present but missing from listing → ALARM (the 2026-06-26 shape)", async () => {
  const d = new ObsidianDriver(new StubExecutor((args) => {
    if (args[0] === "read") return "(op-n1-1)"; // present
    if (args[0] === "files") return "";          // empty listing — inconsistent!
    return "";
  }));
  await assert.rejects(() => gatherObservation(d, NOTE), AlarmError);
});

test("gatherObservation: absent note (not-found) → canonical null, no anchor check", async () => {
  const d = new ObsidianDriver(new StubExecutor((args) => {
    if (args[0] === "read") return `Error: File "${NOTE}" not found.`;
    if (args[0] === "files") return ""; // empty is fine: nothing present to anchor on
    return "";
  }));
  const obs = await gatherObservation(d, NOTE);
  assert.equal(obs.canonical, null);
});
