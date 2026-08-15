// Proactively exercise every obsidian-cli command the harness depends on, and report whether
// each still produces output the parsers can POSITIVELY recognize.
//
// WHY THIS EXISTS. cli-parse.ts already refuses to guess: output it can't positively identify
// becomes a fatal CliUnrecognizedOutput, which the runner turns into a `-UNKNOWN` rep. That guard
// is correct and stays — output can change under us at any moment. But it is REACTIVE: you find
// out mid-soak, having spent a rep (and, in practice, discovering it the morning after). An
// obsidian-cli format change is the single most likely breakage after an Obsidian upgrade, which
// is exactly when `make check-assumptions` gets run — so this moves the DISCOVERY earlier, to a
// deliberate pass you can run before committing to an overnight soak.
//
// It adds NO parsing logic of its own. It drives the ordinary ObsidianDriver, which already
// throws on unrecognized output; the only thing here is calling each command in turn and
// reporting which one drifted, together with what it actually said, so the fix is obvious.
//
// Distinct from `make smoke` (src/smoke.ts), which points at a LOCAL vault and dumps raw output
// for a human to read while DESIGNING parsers. This asserts the existing parsers still hold,
// against the container nodes, non-interactively, with an exit code.
//
//   --nodes   comma-separated container names   (default n1,n2)
//   --bin     CLI path inside the container     (default /opt/obsidian/obsidian-cli)
//
// Exits 0 if every command on every node was recognized, 1 otherwise (2 = couldn't even start).
// Leaves nothing behind: its scratch note lives under bughunt/ and is deleted at the end.

import { parseArgs } from "node:util";
import { ContainerExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { CliUnrecognizedOutput } from "./cli-parse.js";
import { NOTE_DIR } from "./types.js";
import type { OpResult } from "./types.js";

const { values } = parseArgs({ options: { nodes: { type: "string" }, bin: { type: "string" } } });
const nodes = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim()).filter(Boolean);
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";

if (nodes.length === 0) {
  console.error("check-cli: --nodes must name at least one container");
  process.exit(2);
}

type Outcome = { command: string; ok: boolean; detail: string };

/** Run one driver call and classify it the way the harness itself would.
 *
 *  Three outcomes, and the middle one is the whole point:
 *   - recognized       -> the parser still holds (whether the answer is ok:true or a clean error)
 *   - CliUnrecognizedOutput with code 0 -> the CLI answered, but in a shape we no longer parse:
 *                         FORMAT DRIFT, the thing this check exists to catch
 *   - CliUnrecognizedOutput with code!=0 -> the exec itself failed (container down); reported as
 *                         an infrastructure problem, not drift, exactly as run.ts's readState()
 *                         makes the same distinction. */
async function probe(command: string, call: () => Promise<OpResult<unknown>>): Promise<Outcome> {
  try {
    const r = await call();
    // A returned OpResult is NOT self-evidently a good answer: `parseFilesList` maps empty stdout
    // to `[]` by design (cli-parse.ts's own comment says an empty list is not a positive "empty
    // folder"), so a `files` call against a dead container comes back ok:true with an empty list.
    // Found by running this check against a container that doesn't exist — it reported a cheerful
    // "recognized". Judge the exec first, and only then the parse.
    if (r.raw.code !== 0 || r.raw.killed) {
      return { command, ok: false, detail: `exec failed (code=${r.raw.code}${r.raw.killed ? ", killed" : ""}) — container down? ${(r.raw.stderr || r.raw.stdout).trim().slice(0, 200)}` };
    }
    // `ok:false` is fine here: a positively-recognized "not found" is a parsed answer, not drift.
    // We are testing the PARSER, not the vault's contents.
    return { command, ok: true, detail: r.ok ? "recognized" : `recognized (reported: ${r.error ?? "not-ok"})` };
  } catch (e) {
    if (e instanceof CliUnrecognizedOutput) {
      const { code, stdout, stderr } = e.raw;
      if (code !== 0) {
        return { command, ok: false, detail: `exec failed (code=${code}) — container down? ${(stderr || stdout).trim().slice(0, 200)}` };
      }
      return {
        command, ok: false,
        detail: `FORMAT DRIFT — obsidian-cli answered, but cli-parse.ts no longer recognizes it.\n` +
                `      stdout: ${JSON.stringify(stdout.trim().slice(0, 300))}\n` +
                `      stderr: ${JSON.stringify(stderr.trim().slice(0, 200))}`,
      };
    }
    return { command, ok: false, detail: `unexpected error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

let failed = 0;
let skipped = 0;

for (const node of nodes) {
  const executor = new ContainerExecutor(node, bin);
  const d = new ObsidianDriver(executor);

  // Liveness first, so a stopped container produces ONE honest line rather than eight
  // "FORMAT DRIFT"-adjacent ones blaming the parsers for a container that isn't there.
  // `exec true` is the least ambiguous probe available and works the same on both engines.
  const alive = await executor.shell(["true"], { timeoutMs: 15_000 });
  if (alive.code !== 0) {
    console.log(`\n=== ${node} ===\n  SKIP  container not running — start it with 'make containers-up'`);
    skipped++;
    continue;
  }

  // Under bughunt/ like every other harness note, so a real vault is never touched, and uniquely
  // named so a concurrent run (or a previous interrupted check) can't collide with it.
  const note = `${NOTE_DIR}/checkcli-${node}-${Date.now()}`;
  console.log(`\n=== ${node} ===`);

  // Ordered so the scratch note exists before anything reads it. `create` first also means a
  // failure here reports as a create problem rather than as a confusing read-of-nothing.
  const results: Outcome[] = [];
  results.push(await probe("vault info=name", () => d.vaultNameProbe(15_000).then(toOp)));
  results.push(await probe("sync:status", () => d.syncStatus()));
  results.push(await probe("create", () => d.createNote(note, "(checkcli)")));
  results.push(await probe("read", () => d.read(note)));
  results.push(await probe("append", () => d.appendLine(note, "(checkcli-2)")));
  results.push(await probe(`files folder=${NOTE_DIR}`, () => d.listFiles(NOTE_DIR)));
  results.push(await probe("sync:history file= total", () => d.syncVersionsTotal(note)));
  // Cleanup is also a probe: `delete` is a command the harness relies on (clean-notes.ts), so a
  // drift in its reply matters too — and doing it last leaves the vault as we found it.
  results.push(await probe("delete permanent", () => d.deleteNote(note, true)));

  for (const r of results) {
    console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.command.padEnd(24)} ${r.detail}`);
    if (!r.ok) failed++;
  }
}

/** vaultNameProbe reports a status union rather than an OpResult (it is used as a soft probe
 *  elsewhere); adapt it so it can share the same classification path as every other command. */
function toOp(p: { status: "ok"; name: string } | { status: "unrecognized" | "timeout" }): OpResult<string> {
  const raw = { argv: [], code: 0, stdout: "", stderr: "", startedAt: "", durationMs: 0, killed: false };
  if (p.status === "ok") return { ok: true, value: p.name, raw };
  throw new CliUnrecognizedOutput({ ...raw, argv: ["vault", "info=name"], stdout: `<${p.status}>` }, "vaultNameProbe");
}

console.log();
// Exit 3 (not 1) when every node was skipped: "the nodes are down" is a different answer from
// "the parsers drifted", and the caller (scripts/check-assumptions.sh) reports it as a skip
// rather than a failure — this check is meant to be runnable before `make containers-up`.
if (skipped === nodes.length) {
  console.log(`check-cli: SKIPPED — no node was running (${nodes.join(", ")}). Run 'make containers-up' to include this check.`);
  process.exit(3);
}
if (failed === 0) {
  const checked = nodes.length - skipped;
  console.log(`check-cli: PASS — every obsidian-cli command the harness depends on still parses, on ${checked} node(s).`);
  process.exit(0);
}
console.error(
  `check-cli: FAIL — ${failed} command(s) no longer produce recognized output.\n` +
  `  If this followed an Obsidian upgrade, the parsers in src/cli-parse.ts need updating to the new\n` +
  `  format (see docs/cli-trust.md for the rules they follow). Until then, runs will burn reps as\n` +
  `  -UNKNOWN whenever they hit the drifted command.`,
);
process.exit(1);
