// What does `sync:history file=<n> total` actually report, and when?
//
// The harness already reads that counter twice per wait and logs it as the `from`/`to` of every
// `synced` event — but two claims about it have never been verified, and they are in tension:
//
//   execute.ts:305  "blocks until the queried node has caught up"
//   driver.ts:411   "server-side (all nodes agree)"
//
// If both hold, ASKING THE QUESTION FORCES THE WAIT: the counter could never reveal a pending pull,
// because it would only answer once there is nothing left to pull. That single fact decides whether
// the harness can ever detect the case worth detecting — a user who waited, gave up, and edited
// while a sync was still in flight — so it is measured here rather than assumed.
//
// Design note: this only ever READS the counter. The harness's rule is that `W` behaves on
// user-visible signals (sync:status, file contents) and merely records everything else; nothing
// here is meant to change that.
//
// Usage: npm run probe-sync-versions [-- --nodes n1,n2]
//        Needs the nodes up. Creates one note under bughunt/ like any rep does.

import { parseArgs } from "node:util";
import { ContainerExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { readCanonical } from "./runner.js";
import { NOTE_DIR } from "./types.js";

const { values } = parseArgs({ options: { nodes: { type: "string" }, bin: { type: "string" } } });
const names = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim()).filter(Boolean);
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
if (names.length < 2) {
  console.error("probe-sync-versions: needs two nodes, e.g. --nodes n1,n2");
  process.exit(2);
}
const [n1, n2] = names.map((n) => new ObsidianDriver(new ContainerExecutor(n, bin)));

const ms = async <T>(fn: () => Promise<T>): Promise<{ v: T; ms: number }> => {
  const t = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t };
};
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (s: string) => console.log(`  ${s}`);

const note = `${NOTE_DIR}/probe-${Date.now().toString(36)}`;
const TOKEN = "(probe-token)";

async function main(): Promise<void> {
  console.log(`probe-sync-versions: note=${note} nodes=${names.join(",")}\n`);

  // --- setup: a note both nodes agree on, so we start from a genuinely settled state ----------
  console.log("0. setup — create the note on n1 and let both nodes settle");
  await n1.createNote(note, "seed\n");
  for (let i = 0; i < 30; i++) {
    const a = await readCanonical(n1, note);
    const b = await readCanonical(n2, note);
    if (a !== null && b !== null) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  say(`n1 has it: ${(await readCanonical(n1, note)) !== null}, n2 has it: ${(await readCanonical(n2, note)) !== null}`);

  // --- 1. cost on a settled node --------------------------------------------------------------
  console.log("\n1. cost of `total` with nothing pending (bounds whether it could ever be POLLED)");
  for (const [label, d] of [["n1", n1], ["n2", n2]] as const) {
    const r = await ms(() => d.syncVersionsTotal(note));
    say(`${label}: total=${r.v.ok ? r.v.value : `!ok(${r.v.raw.stdout.trim().slice(0, 40)})`}  in ${r.ms}ms`);
  }

  // --- 2+3+4. the crux: append on n1, then race to observe n2 ---------------------------------
  console.log("\n2-4. n1 appends; then WITHOUT waiting, ask n2 for its total and its content.");
  say("   If total rises before n2's content has the token, a pending PULL is observable.");
  say("   If instead the call takes seconds, asking forced the wait and observation is impossible.");
  const before1 = await n1.syncVersionsTotal(note);
  const before2 = await n2.syncVersionsTotal(note);
  say(`baseline: n1 total=${before1.value} n2 total=${before2.value}`);

  const tAppend = Date.now();
  await n1.appendLine(note, TOKEN);
  say(`${stamp()} appended on n1 (+${Date.now() - tAppend}ms)`);

  // n1's own view first: does its total count the version before the push has necessarily landed?
  const p1 = await ms(() => n1.syncVersionsTotal(note));
  say(`${stamp()} n1 total=${p1.v.ok ? p1.v.value : "!ok"} in ${p1.ms}ms   (push-pending visibility)`);

  // then n2, interleaving content and counter so their order is visible
  for (let i = 0; i < 8; i++) {
    const c = await ms(() => readCanonical(n2, note));
    const t = await ms(() => n2.syncVersionsTotal(note));
    const has = (c.v ?? "").includes(TOKEN);
    say(`${stamp()} n2 content-has-token=${String(has).padEnd(5)} (${c.ms}ms)   total=${t.v.ok ? t.v.value : "!ok"} (${t.ms}ms)`);
    if (has) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // --- 5. cross-node agreement once settled ---------------------------------------------------
  console.log("\n5. cross-node agreement, once both have the token");
  const f1 = await n1.syncVersionsTotal(note);
  const f2 = await n2.syncVersionsTotal(note);
  say(`n1 total=${f1.value}  n2 total=${f2.value}  agree=${f1.value === f2.value}`);

  // --- 6. the scenario the "blocks until caught up" comment was actually written about --------
  // execute.ts:305 justifies reading the baseline lazily by saying the call would "stall the whole
  // settle" on a just-reconnected, still-syncing node. Steps 1-5 never partition anything, so they
  // cannot test that. Do it directly: take n2 offline, let n1 write while it is away, bring it back
  // and time the very first `total` against the first content read.
  console.log("\n6. after a real partition — the case the `blocks until caught up` comment describes");
  const engine = (await import("./engine.js")).engineBin();
  const { runProcess } = await import("./exec.js");
  await runProcess(engine, ["network", "disconnect", "obsidian-net", names[1]]);
  say(`${stamp()} n2 disconnected`);
  await n1.appendLine(note, "(offline-token)");
  say(`${stamp()} n1 appended while n2 was away`);
  await new Promise((r) => setTimeout(r, 3000));
  await runProcess(engine, ["network", "connect", "--ip", `10.89.0.${100 + Number(names[1].replace(/\D/g, ""))}`, "obsidian-net", names[1]]);
  say(`${stamp()} n2 reconnected — timing its FIRST total and content read`);
  for (let i = 0; i < 10; i++) {
    const t = await ms(() => n2.syncVersionsTotal(note));
    const c = await ms(() => readCanonical(n2, note));
    const has = (c.v ?? "").includes("(offline-token)");
    say(`${stamp()} total=${t.v.ok ? t.v.value : "!ok"} (${t.ms}ms)   content-has-token=${String(has).padEnd(5)} (${c.ms}ms)`);
    if (has) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\nLeft behind: ${note}.md on both nodes (\`make clean-notes\` removes it).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
