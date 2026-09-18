// Maintenance one-off: delete the harness's notes (everything under the bughunt/
// folder) on ONE node and let Sync propagate the deletions to the others. Scoped to bughunt/ ON
// PURPOSE — it must never touch a real, in-use vault's own notes. Run after
// `make containers-up` for a clean baseline so an accumulated vault doesn't skew a run.
//
//   npm run clean-notes -- --nodes n1,n2

import { parseArgs } from "node:util";
import { ContainerExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { sleep } from "./runner.js";
import { NOTE_DIR } from "./types.js";

const { values } = parseArgs({ options: { nodes: { type: "string" }, bin: { type: "string" } } });
const nodes = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim());
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
const drivers = nodes.map((n) => new ObsidianDriver(new ContainerExecutor(n, bin)));

for (const d of drivers) await d.syncResume();

// Delete only the notes under bughunt/. `files folder=bughunt` lists them verbatim
// (with `.md`, spaces, parens) and `delete file=<name>` accepts them as-is; deleting
// an already-gone note is a harmless no-op.
//
// ONE NODE deletes, and Sync carries the deletions to the rest. Deleting on every node
// instead means several nodes independently removing the same file at the same time —
// concurrent writes to the same notes, which is the thing this harness spends its life
// producing deliberately, arriving here as a side effect of tidying up. The wait below
// then stops being a formality and becomes the check that the deletions actually
// propagated.
const [first] = drivers;
const listed = (await first.listFiles(NOTE_DIR)).value ?? [];
console.log(`${first.node}: deleting ${listed.length} notes under ${NOTE_DIR}/`);
for (const f of listed) await first.deleteNote(f, true);

// Wait until every node reports bughunt/ empty (bounded), so the deletions reached
// the server and converged everywhere.
const deadline = Date.now() + 120_000;
let converged = false;
for (;;) {
  const counts = await Promise.all(drivers.map(async (d) => (await d.listFiles(NOTE_DIR)).value?.length ?? 0));
  console.log(`remaining: ${nodes.map((n, i) => `${n}=${counts[i]}`).join(" ")}`);
  if (counts.every((c) => c === 0)) { converged = true; console.log(`${NOTE_DIR}/ empty on all nodes`); break; }
  if (Date.now() > deadline) break;
  await sleep(3000);
}

// A note that only ever existed on ANOTHER node — left behind by a rep that ended while
// that node was partitioned — was never the deleting node's to delete, so no amount of
// waiting will remove it. Sweep those where they are, and say so: the point of this
// command is to leave a clean vault, and a silent timeout leaves the next run measuring
// against yesterday's litter.
if (!converged) {
  console.log(`timeout waiting for ${NOTE_DIR}/ to empty — sweeping what is left, node by node`);
  for (const d of drivers.slice(1)) {
    const left = (await d.listFiles(NOTE_DIR)).value ?? [];
    if (left.length === 0) continue;
    console.log(`${d.node}: deleting ${left.length} note(s) that never reached ${first.node}`);
    for (const f of left) await d.deleteNote(f, true);
  }
}
process.exit(0);
