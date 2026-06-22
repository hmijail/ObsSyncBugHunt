// Test entrypoint: drives the containerized nodes via `podman exec`, generates
// randomized operation histories, runs them, and tallies the verdicts.
//
// Default is the MOST BENIGN scenario for Sync: no isolation, append-only, and
// cross-node edits wait for the note to be synced everywhere first (no
// concurrency). Aggressive knobs are opt-in flags. Env vars:
//
//   NODES         comma-separated container names         (default "n1,n2")
//   OBSIDIAN_BIN  CLI path inside the container           (default "/opt/obsidian/obsidian-cli")
//   ISOLATOR      "sync" | "network"                      (default "sync")
//   NETWORK       podman network (for ISOLATOR=network)   (default "obsidian-net")
//   SCENARIO      "random" | "stale"                      (default "random")
//   OPS           op-count range "min-max"                (default "6-12")
//   NOTES         max distinct notes per history          (default 2)
//   CAMPAIGN      number of histories to run              (default 1)
//   POLL_SEC / SETTLE_POLLS / CAP_SEC  sync wait          (defaults 1 / 2 / 60)
//   --- aggressive flags (default off = benign) ---
//   ISOLATE_PROB  chance a history isolates a node        (default 0)
//   PREPEND       =1 to allow prepend edits               (default append-only)
//   CONCURRENT    =1 to allow concurrent cross-node edits (default wait-for-synced)
//
//   npm run start

import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type History } from "./generator.js";

const flag = (v: string | undefined) => v === "1" || v === "true";

const nodes = (process.env.NODES ?? "n1,n2").split(",").map((s) => s.trim());
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
  isolateProb: Number(process.env.ISOLATE_PROB ?? 0), // benign: no isolation
  prepend: flag(process.env.PREPEND), // benign: append-only
};
const execOpts: ExecuteOpts = {
  pollSec: Number(process.env.POLL_SEC ?? 1),
  settlePolls: Number(process.env.SETTLE_POLLS ?? 2),
  capSec: Number(process.env.CAP_SEC ?? 60),
  dwellSec: Number(process.env.DWELL_SEC ?? 10),
  concurrent: flag(process.env.CONCURRENT), // benign: wait-for-synced before cross-node edits
};

const drivers = nodes.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));
const byId = new Map(drivers.map((d) => [d.node, d]));
const isolator: Isolator =
  isolatorKind === "network" ? new PodmanIsolator(network) : new SyncToggleIsolator(byId);

// Time-only stamp (no date) keeps note titles short; +h+i makes them unique.
const hhmmss = () => new Date().toISOString().slice(11, 19).replace(/:/g, "-");

console.log(
  `nodes=${nodes.join(",")} isolator=${isolatorKind} scenario=${scenario} ops=${ops.join("-")} ` +
    `campaign=${campaign} isolateProb=${baseParams.isolateProb} prepend=${baseParams.prepend} concurrent=${execOpts.concurrent}`,
);

// Long-running mode for overnight soaks: DURATION_MIN>0 runs for that long;
// else CAMPAIGN<=0 runs until killed; else CAMPAIGN histories. Each history is a
// self-contained run dir, so Ctrl-C just stops after the current one — the
// analyzer reads whatever completed.
const durationMin = Number(process.env.DURATION_MIN ?? 0);
const startedAt = Date.now();
const keepGoing = (h: number) =>
  durationMin > 0 ? Date.now() - startedAt < durationMin * 60_000 : campaign <= 0 ? true : h < campaign;

let pass = 0;
let fail = 0;
let conflicts = 0; // histories where a conflict occurred (benign mode expects zero)
const failures: string[] = [];

const tally = () =>
  `\n=== TALLY: PASS=${pass} FAIL=${fail} run=${pass + fail}  (histories with any conflict: ${conflicts}) ===` +
  (failures.length ? "\nfailing histories:\n" + failures.map((f) => "  " + f).join("\n") : "");
process.on("SIGINT", () => {
  console.log(tally());
  process.exit(fail === 0 ? 0 : 1);
});

for (let h = 0; keepGoing(h); h++) {
  const params: GenParams = { ...baseParams, noteName: (i) => `note-${hhmmss()}-${h}-${i}` };
  const history: History = scenario === "stale" ? staleReconnect(params) : generateHistory(params);

  const logger = new RunLogger();
  logger.artifact("meta.json", {
    scenario,
    isolator: isolatorKind,
    concurrent: execOpts.concurrent,
    isolateProb: baseParams.isolateProb,
    prepend: baseParams.prepend,
    ops: ops.join("-"),
    nodes,
  });
  console.log(`\n=== history ${h + 1} (${history.length} ops) → ${logger.dir} ===`);
  const { verdict, timings } = await runHistory(drivers, isolator, logger, history, execOpts);

  const bad = verdict.notes.flatMap((n) => [
    ...n.lost.map((t) => `lost ${t}`),
    ...n.duplicated.map((d) => `dup ${d.token}`),
    ...(n.converged ? [] : ["diverged"]),
  ]);
  const conflictFiles = Math.max(0, ...verdict.notes.map((n) => n.conflictFiles));
  const onlyInConflict = verdict.notes.reduce((s, n) => s + n.onlyInConflict.length, 0);
  const hadConflict = conflictFiles > 0 || onlyInConflict > 0;
  if (hadConflict) conflicts++;

  if (verdict.ok) {
    pass++;
    const tag = hadConflict ? `CONFLICT (files=${conflictFiles}, onlyInConflict=${onlyInConflict})` : "clean";
    console.log(`history ${h + 1}: PASS ${tag} (convergenceSec=${timings.convergenceSec}${timings.syncTimedOut ? " TIMEOUT" : ""})`);
  } else {
    fail++;
    failures.push(logger.dir);
    console.log(`history ${h + 1}: *** FAIL *** ${bad.join("; ")} (see ${logger.dir})`);
  }
}

console.log(tally());
process.exit(fail === 0 ? 0 : 1);
