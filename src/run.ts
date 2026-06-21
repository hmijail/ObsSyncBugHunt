// Test entrypoint: drives the containerized nodes via `podman exec` and runs one
// divergence round. Configured via environment variables:
//
//   NODES          comma-separated container names      (default "n1,n2")
//   VAULT          test vault name inside the nodes      (default "TestVault")
//   OBSIDIAN_BIN   CLI path inside the container         (default "/usr/local/bin/obsidian")
//   ISOLATOR       "sync" (control) | "network" (rude)   (default "sync")
//   NETWORK        podman network (for ISOLATOR=network) (default "obsidian-net")
//   NOTE           note to contend on                    (default "conv-<ts>")
//   ISOLATED       which node goes offline               (default first node)
//   QUIESCENCE_MS / PROPAGATION_MS / POLL_MS             (timeouts)
//
//   npm run start

import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runDivergenceRound } from "./runner.js";

const nodes = (process.env.NODES ?? "n1,n2").split(",").map((s) => s.trim());
const vault = process.env.VAULT ?? "TestVault";
const bin = process.env.OBSIDIAN_BIN ?? "/usr/local/bin/obsidian";
const network = process.env.NETWORK ?? "obsidian-net";
const isolatorKind = process.env.ISOLATOR ?? "sync";
const note = process.env.NOTE ?? `conv-${Date.now()}`;
const isolated = process.env.ISOLATED ?? nodes[0];

const drivers = nodes.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin), vault));
const byId = new Map(drivers.map((d) => [d.node, d]));

const isolator: Isolator =
  isolatorKind === "network" ? new PodmanIsolator(network) : new SyncToggleIsolator(byId);

console.log(
  `nodes=${nodes.join(",")} vault=${vault} isolator=${isolatorKind} isolated=${isolated} note=${note}`,
);

const logger = new RunLogger();
const verdict = await runDivergenceRound(drivers, isolator, logger, {
  note,
  isolatedNode: isolated,
  quiescenceMs: Number(process.env.QUIESCENCE_MS ?? 180_000),
  basePropagationMs: Number(process.env.PROPAGATION_MS ?? 120_000),
  pollMs: Number(process.env.POLL_MS ?? 2_000),
});

console.log("\n=== VERDICT ===");
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.ok ? 0 : 1);
