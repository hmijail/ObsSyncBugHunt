// Maintenance one-off: empty the vault on every node by deleting all notes through
// the Obsidian CLI and letting Sync propagate the deletions (server + peers). Run
// after `make containers-up` for a clean baseline so an accumulated vault doesn't skew a run.
//
//   npm run clean-notes        (NODES=n1,n2 by default)

import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { sleep } from "./runner.js";

const nodes = (process.env.NODES ?? "n1,n2").split(",").map((s) => s.trim());
const bin = process.env.OBSIDIAN_BIN ?? "/opt/obsidian/obsidian-cli";
const drivers = nodes.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));

for (const d of drivers) await d.syncResume();

// Delete every listed note on every node. `files` lists names verbatim (with `.md`,
// spaces, parens) and `delete file=<name>` accepts them as-is; deleting an already
// gone note is a harmless no-op. Doing it on all nodes avoids one node re-uploading
// what another just deleted.
for (const d of drivers) {
  const r = await d.listFiles();
  const files = r.value ?? [];
  console.log(`${d.node}: deleting ${files.length} notes`);
  for (const f of files) await d.deleteNote(f, true);
}

// Wait until every node reports an empty vault (bounded), so the deletions reached
// the server and converged everywhere.
const deadline = Date.now() + 120_000;
for (;;) {
  const counts = await Promise.all(drivers.map(async (d) => (await d.listFiles()).value?.length ?? 0));
  console.log(`remaining: ${nodes.map((n, i) => `${n}=${counts[i]}`).join(" ")}`);
  if (counts.every((c) => c === 0)) { console.log("vault empty on all nodes"); break; }
  if (Date.now() > deadline) { console.log("timeout waiting for an empty vault"); break; }
  await sleep(3000);
}
process.exit(0);
