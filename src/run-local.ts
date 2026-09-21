// Local pipeline check: ONE node, real Obsidian, throwaway vault, NoopIsolator.
//
// It cannot produce divergence (a single node has nothing to conflict with), so
// the verdict should always be ok. The point is to validate the end-to-end
// plumbing — create → propagate → append → quiesce (via real sync:status) →
// observe → oracle — against the live CLI before adding container complexity.
//
//   npm run local -- --vault throwaway [--bin obsidian]
//
// The local CLI acts on whichever vault Obsidian currently has open — `vault=` cannot switch to
// another one, it is silently ignored. So --vault is an ASSERTION, not an instruction: it names
// the throwaway vault that must already be open, and the run refuses to start unless the CLI
// itself confirms that is the active vault (src/local-vault.ts). This matters beyond the writes:
// sync:status reports the active vault and quiescence trusts it exclusively, so being on the
// wrong vault does not merely write in the wrong place, it judges the wrong thing.
// A test note is left behind each run.

import { parseArgs } from "node:util";
import { LocalExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { NoopIsolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runDivergenceRound } from "./runner.js";
import { LocalVaultMismatch, requireActiveVault } from "./local-vault.js";
import { DEFAULT_LOCAL_BIN, NOTE_DIR } from "./types.js";

const { values } = parseArgs({ options: { vault: { type: "string" }, bin: { type: "string" } } });
const bin = values.bin ?? DEFAULT_LOCAL_BIN;
const vault = values.vault;

if (!vault) {
  console.error("Pass --vault <name> for a throwaway vault (never a real one).");
  process.exit(2);
}

const driver = new ObsidianDriver(new LocalExecutor(bin, "local"));

// Before the round, which writes.
//
// Note this guard is a one-shot check at startup, NOT the continuous one. execute.ts's
// assertLocalVaultUnchanged is what watches for drift during a real run, against a baseline
// run.ts captures the same way. Two different questions: "is this the right vault to begin
// with" and "is it still the same one" — this file only ever asked the second, by never asking
// the first.
try {
  await requireActiveVault(driver, vault);
} catch (e) {
  if (e instanceof LocalVaultMismatch) {
    console.error(`\ncheck-local: refusing to run — ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}

const logger = new RunLogger();

const verdict = await runDivergenceRound([driver], new NoopIsolator(), logger, {
  note: `${NOTE_DIR}/local-${Date.now()}`,
  isolatedNode: "local",
  basePropagationMs: 30_000,
  quiescenceMs: 60_000,
  pollMs: 2_000,
});

console.log("\n=== VERDICT (single-node plumbing check) ===");
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
