// Local pipeline check: ONE node, real Obsidian, throwaway vault, NoopIsolator.
//
// It cannot produce divergence (a single node has nothing to conflict with), so
// the verdict should always be ok. The point is to validate the end-to-end
// plumbing — create → propagate → append → quiesce (via real sync:status) →
// observe → oracle — against the live CLI before adding container complexity.
//
//   npm run local -- --vault Throwaway [--bin /path/to/Obsidian]
//
// The local CLI acts on whichever vault Obsidian currently has open, so --vault
// is only a safety acknowledgment that a throwaway vault (never a real one) is
// open — make sure it actually is, since sync:status reports the active vault and
// quiescence trusts it exclusively. A test note is left behind each run.

import { parseArgs } from "node:util";
import { LocalExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { NoopIsolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runDivergenceRound } from "./runner.js";

const { values } = parseArgs({ options: { vault: { type: "string" }, bin: { type: "string" } } });
const bin =
  values.bin ??
  "/Users/mija/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const vault = values.vault;

if (!vault) {
  console.error("Pass --vault <name> for a throwaway vault (never a real one).");
  process.exit(2);
}

const driver = new ObsidianDriver(new LocalExecutor(bin, "local"));
const logger = new RunLogger();

const verdict = await runDivergenceRound([driver], new NoopIsolator(), logger, {
  note: `local-${Date.now()}`,
  isolatedNode: "local",
  basePropagationMs: 30_000,
  quiescenceMs: 60_000,
  pollMs: 2_000,
});

console.log("\n=== VERDICT (single-node plumbing check) ===");
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
