import test from "node:test";
import assert from "node:assert/strict";
import { CliInconsistencyError, categoryOf, quoteArgv, siteOf, describeInconsistency } from "./inconsistency.js";
import { CliUnrecognizedOutput } from "./cli-parse.js";
import type { ExecResult } from "./types.js";

const fakeExec = (argv: string[], stdout: string): ExecResult => ({
  argv, code: 0, stdout, stderr: "", startedAt: "", durationMs: 0, killed: false,
});

test("quoteArgv: bare tokens are left alone", () => {
  assert.equal(
    quoteArgv(["podman", "exec", "n1", "/opt/obsidian/obsidian-cli", "read", "file=bughunt/x.md"]),
    "podman exec n1 /opt/obsidian/obsidian-cli read file=bughunt/x.md",
  );
});

test("quoteArgv: args with spaces/newlines are single-quoted", () => {
  assert.equal(quoteArgv(["read", "file=a b.md"]), "read 'file=a b.md'");
  assert.equal(quoteArgv(["content=line1\nline2"]), "'content=line1\nline2'");
});

test("quoteArgv: embedded single quotes are escaped", () => {
  assert.equal(quoteArgv(["content=it's"]), "'content=it'\\''s'");
});

test("categoryOf: CLI/FS + listing disagreements are obsfail, the rest unknown", () => {
  assert.equal(categoryOf(new CliInconsistencyError("cli-fs-disagreement")), "obsfail");
  assert.equal(categoryOf(new CliInconsistencyError("cli-listing-inconsistent")), "obsfail");
  assert.equal(categoryOf(new CliInconsistencyError("cli-permanently-unresponsive")), "unknown");
  assert.equal(categoryOf(new CliUnrecognizedOutput(fakeExec(["files"], "???"))), "unknown");
});

test("siteOf: returns the throw site in src/, not the error-class file", () => {
  // Thrown here so the top non-inconsistency/cli-parse frame is THIS test file under src/.
  let err: Error;
  try { throw new CliInconsistencyError("cli-fs-disagreement"); } catch (e) { err = e as Error; }
  const site = siteOf(err);
  assert.ok(site, "expected a site");
  assert.match(site!, /^src\/.+:\d+:\d+$/);
  assert.doesNotMatch(site!, /inconsistency\.ts|cli-parse\.ts/);
});

test("describeInconsistency: an unrecognized output → -UNKNOWN naming the recognizer + copy-paste command + raw stdout", () => {
  const raw = fakeExec(
    ["podman", "exec", "n1", "/opt/obsidian/obsidian-cli", "sync:history", "file=bughunt/x.md", "total"],
    "Error: Sync is in error state. Check sync settings.",
  );
  const d = describeInconsistency(new CliUnrecognizedOutput(raw, "parseTotal"));
  assert.equal(d.category, "unknown");
  assert.equal(d.suffix, "-UNKNOWN");
  assert.equal(d.recognizer, "parseTotal"); // the cli-parse.ts function to teach the new shape
  assert.equal(d.command, "podman exec n1 /opt/obsidian/obsidian-cli sync:history file=bughunt/x.md total");
  assert.equal(d.stdout, "Error: Sync is in error state. Check sync settings.");
});

test("siteOf: the ObsidianDriver.expect plumbing frame is skipped (lands on the method that called it)", () => {
  // A synthetic V8 stack: constructor frame, then the generic `expect`, then the real method.
  const err = new Error("x");
  err.stack = [
    "Error: x",
    "    at new CliUnrecognizedOutput (/repo/src/cli-parse.ts:18:5)",
    "    at ObsidianDriver.expect (/repo/src/driver.ts:66:40)",
    "    at ObsidianDriver.syncVersionsTotal (/repo/src/driver.ts:265:25)",
    "    at async runHistory (/repo/src/execute.ts:120:10)",
  ].join("\n");
  assert.equal(siteOf(err), "src/driver.ts:265:25");
});

test("describeInconsistency: a CLI/FS disagreement → -OBSFAIL carrying its structured detail", () => {
  const d = describeInconsistency(new CliInconsistencyError("cli-fs-disagreement", { node: "n1", cliOnlyCount: 1 }));
  assert.equal(d.category, "obsfail");
  assert.equal(d.suffix, "-OBSFAIL");
  assert.deepEqual(d.detail, { node: "n1", cliOnlyCount: 1 });
  assert.equal(d.command, undefined); // no single CLI line for a cross-check disagreement
});
