// Local pipeline check: ONE node, real Obsidian, throwaway vault, NoopIsolator.
//
// It cannot produce divergence (a single node has nothing to conflict with), so
// the verdict should always be ok. The point is to validate the end-to-end
// plumbing — create → propagate → append → quiesce (via real sync:status) →
// observe → oracle — against the live CLI before adding container complexity.
//
//   OBSIDIAN_BIN=... TEST_VAULT="Throwaway" npm run local
//
// Note: for the sync:status quiescence path to engage, TEST_VAULT must be the
// OPEN vault in Obsidian (sync:status reports on the active vault); otherwise the
// run falls back to content-stability, which is still fine for a plumbing check.
// A test note is left behind in the throwaway vault each run.

import { LocalExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { NoopIsolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runDivergenceRound } from "./runner.js";

const bin =
  process.env.OBSIDIAN_BIN ??
  "/Users/mija/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const vault = process.env.TEST_VAULT;

if (!vault) {
  console.error("Set TEST_VAULT to the name of a throwaway vault (never a real one).");
  process.exit(2);
}

const driver = new ObsidianDriver(new LocalExecutor(bin, "local"), vault);
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
