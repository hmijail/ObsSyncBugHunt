import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "./dsl.js";
import { generateScript, type ReproOpts } from "./repro.js";

const baseOpts: ReproOpts = { nodes: ["n1", "n2"], bin: "/opt/obsidian/obsidian-cli", network: "obsidian-net", runId: "repro-test" };

test("generateScript: a plain append targets the right node, tries append then falls back to create, and opens the note", () => {
  const script = generateScript(parse("N1Aa"), baseOpts);
  assert.match(script, /out=\$\(podman exec n1 "\$BIN" append file=bughunt\/repro-test-a content='\(n1-1-a\)'\)/);
  assert.match(script, /if \[\[ "\$out" != Appended\\ to:\* \]\]; then/);
  assert.match(script, /podman exec n1 "\$BIN" create name=bughunt\/repro-test-a content='\(n1-1-a\)'/);
  assert.match(script, /podman exec n1 "\$BIN" open file=bughunt\/repro-test-a/);
});

test("generateScript: disconnect/connect emit the exact pinned ip/mac nodeAddress computes", () => {
  const script = generateScript(parse("N1DC"), baseOpts);
  assert.match(script, /podman network disconnect obsidian-net n1/);
  // Same pinned identity isolate.ts's own nodeAddress test asserts for n1.
  assert.match(script, /podman network connect --ip 10\.89\.0\.101 --mac-address 6e:62:6e:65:74:65 obsidian-net n1/);
});

test("generateScript: W with nothing appended yet is skipped (matches execute.ts's no-op), a real W after an append is not", () => {
  const skipped = generateScript(parse("N1W"), baseOpts);
  assert.match(skipped, /# W: skipped \(nothing appended yet/);
  // The final reconnect-and-wait block always polls sync:status, so only assert there's no
  // mid-history wait-on-n1 block specifically (the thing a real W would have emitted here).
  assert.doesNotMatch(skipped, /# W: wait for/);

  const real = generateScript(parse("N1AaW"), baseOpts);
  assert.match(real, /# W: wait for n1's own sync:status/);
  assert.match(real, /status=\$\(podman exec n1 "\$BIN" sync:status\)/);
});

test("generateScript: a Mac op uses $MAC_BIN directly, never podman exec, for its own token", () => {
  const script = generateScript(parse("MAa"), { ...baseOpts, macBin: "/path/to/obsidian-cli", macNodeId: "MyMac" });
  assert.match(script, /MAC_BIN='\/path\/to\/obsidian-cli'/);
  assert.match(script, /out=\$\("\$MAC_BIN" append file=bughunt\/repro-test-a content='\(MyMac-1-a\)'\)/);
  assert.doesNotMatch(script, /podman exec .* append file=bughunt\/repro-test-a/);
});

test("generateScript: a history using M without a configured Mac throws a clear error, not a broken script", () => {
  assert.throws(() => generateScript(parse("MAa"), baseOpts), /uses M \(the Mac node\) but no --mac-bin was given/);
});

test("generateScript: an invalid --run-id is rejected", () => {
  assert.throws(() => generateScript(parse("N1Aa"), { ...baseOpts, runId: "not valid!" }), /must match/);
});

test("generateScript: an empty history still produces a valid script — header + final reconnect/wait only", () => {
  const script = generateScript([], baseOpts);
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /--- final: reconnect any still-offline nodes/);
  assert.match(script, /podman network connect --ip 10\.89\.0\.101 --mac-address 6e:62:6e:65:74:65 obsidian-net n1 2>\/dev\/null \|\| true/);
  assert.match(script, /podman network connect --ip 10\.89\.0\.102 --mac-address 6e:62:6e:65:74:66 obsidian-net n2 2>\/dev\/null \|\| true/);
  assert.doesNotMatch(script, /append file=/);
});
