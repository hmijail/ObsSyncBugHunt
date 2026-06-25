// Maintenance one-off: delete the harness's notes (everything under the bughunt/
// folder) on every node and let Sync propagate the deletions. Scoped to bughunt/ ON
// PURPOSE — it must never touch a real, in-use vault's own notes. Run after
// `make containers-up` for a clean baseline so an accumulated vault doesn't skew a run.
//
//   npm run clean-notes -- --nodes n1,n2

import { parseArgs } from "node:util";
import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { sleep } from "./runner.js";
import { NOTE_DIR } from "./types.js";

const { values } = parseArgs({ options: { nodes: { type: "string" }, bin: { type: "string" } } });
const nodes = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim());
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
const drivers = nodes.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));

for (const d of drivers) await d.syncResume();

// Delete only the notes under bughunt/. `files folder=bughunt` lists them verbatim
// (with `.md`, spaces, parens) and `delete file=<name>` accepts them as-is; deleting
// an already-gone note is a harmless no-op. Doing it on all nodes avoids one node
// re-uploading what another just deleted.
for (const d of drivers) {
  const r = await d.listFiles(NOTE_DIR);
  const files = r.value ?? [];
  console.log(`${d.node}: deleting ${files.length} notes under ${NOTE_DIR}/`);
  for (const f of files) await d.deleteNote(f, true);
}

// Wait until every node reports bughunt/ empty (bounded), so the deletions reached
// the server and converged everywhere.
const deadline = Date.now() + 120_000;
for (;;) {
  const counts = await Promise.all(drivers.map(async (d) => (await d.listFiles(NOTE_DIR)).value?.length ?? 0));
  console.log(`remaining: ${nodes.map((n, i) => `${n}=${counts[i]}`).join(" ")}`);
  if (counts.every((c) => c === 0)) { console.log(`${NOTE_DIR}/ empty on all nodes`); break; }
  if (Date.now() > deadline) { console.log(`timeout waiting for ${NOTE_DIR}/ to empty`); break; }
  await sleep(3000);
}
process.exit(0);
