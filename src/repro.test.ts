import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./dsl.js";
import { generateScript, type ReproOpts } from "./repro.js";

const baseOpts: ReproOpts = { nodes: ["n1", "n2"], bin: "/opt/obsidian/obsidian-cli", network: "obsidian-net", runId: "repro-test" };

test("generateScript: sources the bash library exactly once, near the top", () => {
  const script = generateScript(parse("N1Aa"), baseOpts);
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -u\n# N1Aa\nsource '.*\/scripts\/repro-lib\.sh'/);
});

test("generateScript: without --run-id, RUN_ID defaults to the history string itself, not a timestamp", () => {
  const { runId: _unused, ...noRunId } = baseOpts;
  const script = generateScript(parse("N1DMAaWN1AaC"), { ...noRunId, macBin: "/path/to/obsidian-cli" });
  assert.match(script, /^RUN_ID='N1DMAaWN1AaC'$/m); // note paths are built at runtime from NOTE_DIR/RUN_ID inside repro-lib.sh
});

test("generateScript: a plain append is a single, explicit function call — no inline shell", () => {
  const script = generateScript(parse("N1Aa"), baseOpts);
  assert.match(script, /^Append 1 a$/m);
  assert.doesNotMatch(script, /podman exec/); // all podman/CLI mechanics now live in the library, not here
});

test("generateScript: disconnect/connect emit explicit calls, plus the pinned ip/mac as NODE_IP/NODE_MACADDR array entries", () => {
  const script = generateScript(parse("N1DC"), baseOpts);
  assert.match(script, /^Disconnect 1$/m);
  assert.match(script, /^Connect 1$/m);
  // Same pinned identity isolate.ts's own nodeAddress test asserts for n1.
  assert.match(script, /^NODE_IP\[1\]=10\.89\.0\.101$/m);
  assert.match(script, /^NODE_MACADDR\[1\]=6e:62:6e:65:74:65$/m);
});

test("generateScript: a bare W with nothing appended yet is a no-op (matches execute.ts) and emits nothing; a W after an append does", () => {
  const skipped = generateScript(parse("N1W"), baseOpts);
  assert.doesNotMatch(skipped, /^Wait /m);

  const real = generateScript(parse("N1AaW"), baseOpts);
  assert.match(real, /^Wait 1$/m);
});

test("generateScript: a Mac op calls the same functions with selector \"M\", and MAC_BIN/MAC_NODE_ID are set", () => {
  const script = generateScript(parse("MAa"), { ...baseOpts, macBin: "/path/to/obsidian-cli", macNodeId: "MyMac" });
  assert.match(script, /^MAC_BIN='\/path\/to\/obsidian-cli'$/m);
  assert.match(script, /^MAC_NODE_ID='MyMac'$/m);
  assert.match(script, /^Append M a$/m);
  assert.match(script, /^ALL_NODES=\(1 2 M\)$/m);
});

test("generateScript: a history using M without a configured Mac throws a clear error, not a broken script", () => {
  assert.throws(() => generateScript(parse("MAa"), baseOpts), /uses M \(the Mac node\) but no --mac-bin was given/);
});

test("generateScript: an invalid --run-id is rejected", () => {
  assert.throws(() => generateScript(parse("N1Aa"), { ...baseOpts, runId: "not valid!" }), /must match/);
});

test("generateScript: the final step reconnects only nodes still offline, then Waits and Checks every touched note", () => {
  const script = generateScript(parse("N1DAaN2Aa"), baseOpts);
  // n1 was left disconnected (no matching C) -> reconnected once at the very end.
  const connectCalls = [...script.matchAll(/^Connect 1$/gm)];
  assert.equal(connectCalls.length, 1);
  assert.match(script, /^Wait 1$/m);
  assert.match(script, /^Wait 2$/m);
  // Both appends target letter "a", so Check lists both tokens; seq is global across nodes
  // (n1's append is seq 1, n2's is seq 2), not per-node.
  assert.match(script, /^Check a '\(n1-1-a\)' '\(n2-2-a\)'$/m);
});

test("generateScript: no Disconnect at all means no reconnect call is needed at the end", () => {
  const script = generateScript(parse("N1AaN2Aa"), baseOpts);
  assert.doesNotMatch(script, /^Connect /m);
});

test("generateScript: an empty history produces just the boilerplate — no Wait/Check calls, since nothing was ever appended", () => {
  const script = generateScript([], baseOpts);
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /^ALL_NODES=\(1 2\)$/m);
  assert.doesNotMatch(script, /^Wait /m);
  assert.doesNotMatch(script, /^Check /m);
  assert.doesNotMatch(script, /^Append /m);
});

test("scripts/repro-lib.sh is syntactically valid bash (bash -n)", () => {
  const libPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "repro-lib.sh");
  assert.doesNotThrow(() => execFileSync("bash", ["-n", libPath]));
});
