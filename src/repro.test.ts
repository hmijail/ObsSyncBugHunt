import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./dsl.js";
import { generateScript, type ReproOpts } from "./repro.js";

const baseOpts: ReproOpts = { nodes: ["n1", "n2"], bin: "/opt/obsidian/obsidian-cli", network: "obsidian-net", runId: "repro-test" };
const LIB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "repro-lib.sh");
const reproLib = () => readFileSync(LIB_PATH, "utf8");

test("generateScript: sources the bash library exactly once, near the top", () => {
  const script = generateScript(parse("N1Aa"), baseOpts);
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -u\n# N1Aa\nsource '.*\/scripts\/repro-lib\.sh'/);
});

test("generateScript: without --run-id, RUN_ID defaults to the history string itself, not a timestamp", () => {
  const { runId: _unused, ...noRunId } = baseOpts;
  const script = generateScript(parse("N1DLAaWN1AaC"), { ...noRunId, localBin: "/path/to/obsidian-cli" });
  assert.match(script, /^RUN_ID='N1DLAaWN1AaC'$/m); // note paths are built at runtime from NOTE_DIR/RUN_ID inside repro-lib.sh
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

test("generateScript: a local-instance op calls the same functions with selector \"L\", and LOCAL_BIN/LOCAL_NODE_ID are set", () => {
  const script = generateScript(parse("LAa"), { ...baseOpts, localBin: "/path/to/obsidian-cli", localNodeId: "MyLocal" });
  assert.match(script, /^LOCAL_BIN='\/path\/to\/obsidian-cli'$/m);
  assert.match(script, /^LOCAL_NODE_ID='MyLocal'$/m);
  assert.match(script, /^Append L a$/m);
  assert.match(script, /^ALL_NODES=\(1 2 L\)$/m);
});

test("generateScript: a history using L without a configured local instance throws a clear error, not a broken script", () => {
  assert.throws(() => generateScript(parse("LAa"), baseOpts), /uses L \(the local node\) but no --local-bin was given/);
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
  assert.doesNotThrow(() => execFileSync("bash", ["-n", LIB_PATH]));
});

test("generateScript: sets VERBOSE (runtime-overridable) and a fresh per-execution TS", () => {
  const script = generateScript(parse("N1Aa"), baseOpts);
  assert.match(script, /^VERBOSE=\$\{VERBOSE:-0\}$/m);
  assert.match(script, /^TS=\$\(date \+%dT%H%M%S\)$/m);
});

test("scripts/repro-lib.sh: every real command is wrapped in `run` for VERBOSE echoing, except sleep", () => {
  const lib = reproLib();
  for (const pattern of [
    /run \$b append/, /run \$b create/, /run \$b open/, /run \$b sync:status/,
    /run \$b read file/, /run \$b files folder/, /run \$b read path/,
    /run podman network disconnect/, /run podman network connect/,
  ]) {
    assert.match(lib, pattern);
  }
  assert.doesNotMatch(lib, /run sleep/); // deliberately unwrapped — not diagnostically interesting
});

test("scripts/repro-lib.sh: Append aborts (die) if create doesn't report success", () => {
  assert.match(reproLib(), /\[\[ "\$out" == Created:\* \]\] \|\| die/);
});

test("scripts/repro-lib.sh: Disconnect/Connect abort (die) on a nonzero podman exit code", () => {
  const lib = reproLib();
  assert.match(lib, /Disconnect\(\) \{ run podman network disconnect .*\|\| die/);
  assert.match(lib, /Connect\(\)\s+\{ run podman network connect .*\|\| die/);
});
