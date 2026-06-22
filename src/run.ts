// Test entrypoint: drives the containerized nodes via `podman exec`, generates
// randomized operation histories, runs them, and tallies the verdicts.
// Configured via environment variables:
//
//   NODES         comma-separated container names         (default "n1,n2")
//   OBSIDIAN_BIN  CLI path inside the container           (default "/opt/obsidian/obsidian-cli")
//   ISOLATOR      "sync" (control) | "network" (rude)     (default "sync")
//   NETWORK       podman network (for ISOLATOR=network)   (default "obsidian-net")
//   SCENARIO      "random" | "stale"                      (default "random")
//   OPS           op-count range "min-max"                (default "6-12")
//   NOTES         max distinct notes per history          (default 2)
//   ISOLATE_PROB  chance a history uses isolation         (default 0.7)
//   CAMPAIGN      number of histories to run              (default 1)
//   POLL_SEC / SETTLE_POLLS / CAP_SEC  stabilization wait (defaults 1 / 2 / 60)
//
//   npm run start

import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type History } from "./generator.js";

const nodes = (process.env.NODES ?? "n1,n2").split(",").map((s) => s.trim());
// In containers the CLI is the dedicated obsidian-cli binary (the GUI binary
// can't run CLI as root). It must be enabled in Settings > General > Advanced.
const bin = process.env.OBSIDIAN_BIN ?? "/opt/obsidian/obsidian-cli";
const network = process.env.NETWORK ?? "obsidian-net";
const isolatorKind = process.env.ISOLATOR ?? "sync";
const scenario = process.env.SCENARIO ?? "random";
const campaign = Number(process.env.CAMPAIGN ?? 1);

const opsRange = (process.env.OPS ?? "6-12").split("-").map(Number);
const ops: [number, number] = [opsRange[0], opsRange[1] ?? opsRange[0]];
const baseParams: Omit<GenParams, "noteName"> = {
  nodes,
  ops,
  notes: Number(process.env.NOTES ?? 2),
  isolateProb: Number(process.env.ISOLATE_PROB ?? 0.7),
};
const execOpts: ExecuteOpts = {
  pollSec: Number(process.env.POLL_SEC ?? 1),
  settlePolls: Number(process.env.SETTLE_POLLS ?? 2),
  capSec: Number(process.env.CAP_SEC ?? 60),
};

const drivers = nodes.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));
const byId = new Map(drivers.map((d) => [d.node, d]));
const isolator: Isolator =
  isolatorKind === "network" ? new PodmanIsolator(network) : new SyncToggleIsolator(byId);

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");

console.log(
  `nodes=${nodes.join(",")} isolator=${isolatorKind} scenario=${scenario} ops=${ops.join("-")} campaign=${campaign}`,
);

let pass = 0;
let fail = 0;
const failures: string[] = [];

for (let h = 0; h < campaign; h++) {
  const params: GenParams = { ...baseParams, noteName: (i) => `note-${stamp()}-${h}-${i}` };
  const history: History = scenario === "stale" ? staleReconnect(params) : generateHistory(params);

  const logger = new RunLogger();
  console.log(`\n=== history ${h + 1}/${campaign} (${history.length} ops) → ${logger.dir} ===`);
  const { verdict, timings } = await runHistory(drivers, isolator, logger, history, execOpts);

  const bad = verdict.notes.flatMap((n) => [
    ...n.lost.map((t) => `lost ${t}`),
    ...n.duplicated.map((d) => `dup ${d.token}`),
    ...(n.converged ? [] : ["diverged"]),
  ]);
  const maxConflicts = Math.max(0, ...verdict.notes.map((n) => n.conflictFiles));
  if (verdict.ok) {
    pass++;
    console.log(
      `history ${h + 1}: PASS (convergenceSec=${timings.convergenceSec}${timings.syncTimedOut ? " TIMEOUT" : ""}, maxConflictFiles=${maxConflicts})`,
    );
  } else {
    fail++;
    failures.push(logger.dir);
    console.log(`history ${h + 1}: *** FAIL *** ${bad.join("; ")} (see ${logger.dir})`);
  }
}

console.log(`\n=== CAMPAIGN TALLY: PASS=${pass} FAIL=${fail} / ${campaign} ===`);
if (failures.length) console.log("failing histories:\n" + failures.map((f) => "  " + f).join("\n"));
process.exit(fail === 0 ? 0 : 1);
