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
import { engineBin } from "./engine.js";
import { runProcess } from "./exec.js";
import { NOTE_DIR } from "./types.js";

const { values } = parseArgs({ options: { nodes: { type: "string" }, bin: { type: "string" }, check: { type: "boolean" } } });
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

const engine = engineBin();

/** A note BOTH nodes have, so `sync:history` has real server history to look up. Without it every
 *  query answers "not found" in milliseconds and never reaches the path being measured — which is
 *  exactly how the first version of `--check` fooled itself. */
async function settleNote(): Promise<void> {
  await n1.createNote(note, "seed\n");
  for (let i = 0; i < 30; i++) {
    if ((await readCanonical(n1, note)) !== null && (await readCanonical(n2, note)) !== null) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * `--check`: the assertions worth re-running, fast, with an exit code — for check-assumptions.
 *
 * Two claims the settle loop is BUILT on, both of them ours (written from observation, not from any
 * Obsidian documentation) and therefore both liable to expire silently under an upgrade:
 *
 *   driver.ts   "`sync:status` BLOCKS until the node is synced" — the entire bounded-probe design
 *               exists because of this. If it stopped blocking, `syncStateProbe`'s timeout would
 *               stop meaning "not synced yet" and the settle would be reading noise.
 *   driver.ts   sync reads "can silently block for a long time", which is why every attempt is
 *               capped. Measured cause (see docs/DESIGN.md): no network, not merely being behind.
 *
 * Deliberately ONE bounded call per claim rather than the full retry sequence: this needs to cost
 * seconds, not the 75s the exploratory path takes.
 */
async function check(): Promise<number> {
  const CAP_MS = 6000;
  let bad = 0;
  await settleNote(); // the blocking path needs a file the server actually knows about
  const ok = (m: string) => console.log(`      ok   ${m}`);
  const fail = (m: string) => { console.error(`      FAIL ${m}`); bad++; };

  const settled = await ms(() => n2.syncStateProbe(CAP_MS));
  if (settled.v === "synced" && settled.ms < 2000) ok(`a synced node answers sync:status in ${settled.ms}ms`);
  else fail(`expected a prompt "synced" from an idle node, got "${settled.v}" in ${settled.ms}ms`);

  // What does `sync:history` do when the CALLING node has an upload still pending? It is the call
  // that returns the server version count, and both `latency.ts` and the settle lean on the counter,
  // so its behaviour mid-upload decides what the counter can be used for at all. Provoke a pending
  // upload deliberately: a second edit inside the ~10s per-note throttle window cannot go out
  // immediately (see src/probe-propagation.ts), so n1 is holding it while we ask.
  const before = await n1.snapshotVersionsTotal(note, CAP_MS);
  await n1.appendLine(note, "(pending-probe-1)");
  await n1.appendLine(note, "(pending-probe-2)"); // throttled behind the first
  const during = await ms(() => n1.snapshotVersionsTotal(note, CAP_MS));
  if (during.v.status === "timeout") {
    ok(`sync:history BLOCKS on a node with a pending upload (killed at ${CAP_MS}ms) — so a blocked call is itself a "sync in flight" signal`);
  } else if (during.v.status === "ok" && before.status === "ok" && during.v.total === before.total) {
    ok(`a node with a pending upload answers sync:history in ${during.ms}ms with its PRE-upload count (${during.v.total}) — the counter cannot see a sync in flight, not even the node's own`);
  } else if (during.v.status === "ok") {
    fail(`a node with a pending upload reported total=${during.v.total} (was ${before.status === "ok" ? before.total : "?"}) in ${during.ms}ms — the counter now moves ahead of delivery, which would make it a usable pending-sync signal; docs/DESIGN.md says otherwise and needs revisiting`);
  } else {
    fail(`sync:history answered "${during.v.status}" on a node with a pending upload — neither blocking nor a count, so src/driver.ts's parsers need a look`);
  }

  await runProcess(engine, ["network", "disconnect", "obsidian-net", names[1]]);
  try {
    const off = await ms(() => n2.syncStateProbe(CAP_MS));
    if (off.v === "timeout") ok(`an offline node still BLOCKS on sync:status (killed at ${CAP_MS}ms) — the bounded probe still means what the settle assumes`);
    else fail(`an offline node answered sync:status with "${off.v}" in ${off.ms}ms instead of blocking — syncStateProbe's timeout no longer means "not synced"`);

    const exec2 = new ContainerExecutor(names[1], bin);
    const raw = await ms(() => exec2.exec(["sync:history", `file=${note}`, "total"], { timeoutMs: CAP_MS }));
    if (raw.v.killed) ok(`an offline node still blocks on sync:history total (killed at ${CAP_MS}ms) — per-attempt capping still earns its keep`);
    else ok(`an offline node now ANSWERS sync:history total in ${raw.ms}ms ("${raw.v.stdout.trim().slice(0, 40)}") — not a failure, but the long blocks may be gone`);
  } finally {
    await runProcess(engine, ["network", "connect", "--ip", `10.89.0.${100 + Number(names[1].replace(/\D/g, ""))}`, "obsidian-net", names[1]]);
  }
  return bad;
}

async function main(): Promise<void> {
  if (values.check) {
    process.exit(await check());
  }
  console.log(`probe-sync-versions: note=${note} nodes=${names.join(",")}\n`);

  console.log("0. setup — create the note on n1 and let both nodes settle");
  await settleNote();
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

  // --- 7. sync:* calls while the node is OFFLINE ---------------------------------------------
  // The long blocks this code defends against were real once. If they are gone in the current
  // Obsidian, the likeliest surviving cause is asking a Sync question with no network at all — the
  // client cannot reach the server and may sit there rather than answer. Timed here, because
  // "answers in 200ms" and "answers after a 100s bounded-retry sequence" are the same code path
  // from the caller's side and only the clock tells them apart.
  console.log("\n7. sync:* while the node is DISCONNECTED (a likelier cause of the historical stalls)");
  await runProcess(engine, ["network", "disconnect", "obsidian-net", names[1]]);
  say(`${stamp()} n2 disconnected`);
  try {
    // Both calls are expected to END in unrecognized output — that IS the result. What matters is
    // the clock: how much of the wall time was real blocking before the CLI started answering.
    const offTotal = await ms(() => n2.syncVersionsTotal(note).catch((e: unknown) => e));
    const v = offTotal.v;
    const shown = v instanceof Error ? `threw after its retries: ${v.message.slice(0, 60)}…` : JSON.stringify(v);
    say(`${stamp()} sync:history total -> ${shown}`);
    say(`${stamp()}   total wall time ${(offTotal.ms / 1000).toFixed(1)}s — the retry log above shows how much was blocking`);
  } finally {
    // ALWAYS reconnect: the calls above are expected to throw, and leaving a node partitioned
    // would silently poison whatever runs next.
    await runProcess(engine, ["network", "connect", "--ip", `10.89.0.${100 + Number(names[1].replace(/\D/g, ""))}`, "obsidian-net", names[1]]);
    say(`${stamp()} n2 reconnected`);
  }

  console.log(`\nLeft behind: ${note}.md on both nodes (\`make clean-notes\` removes it).`);
}

main().catch(async (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  // This probe deliberately partitions a node. However it fails, put the network back — a probe
  // that leaves the apparatus broken is worse than no probe.
  try {
    await runProcess(engine, ["network", "connect", "--ip", `10.89.0.${100 + Number(names[1].replace(/\D/g, ""))}`, "obsidian-net", names[1]]);
    console.error(`  (reconnected ${names[1]} on the way out)`);
  } catch { /* best effort */ }
  process.exit(1);
});
