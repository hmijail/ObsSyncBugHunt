// Test entrypoint: generates (or takes) a DSL history, runs it REPEAT times
// against the containerized nodes, and tallies. Each history string is a
// directory; each repeat is a sub-run named by epoch6. A non-OK rep dir is
// suffixed -UNSYNCED / -TIMEOUT / -LOST / -DUPL / -DIFF, and a history dir gets
// -BAD<pct> (share of non-OK reps).
//
// Params are CLI args (args-only — env is not read). Use `make` (which maps
// `make soak TURNS=paced` to the flags below), or run directly: `npm run start -- <flags>`.
//
//   --nodes          comma-separated container names         (default n1,n2)
//   --bin            CLI path inside the container           (default /opt/obsidian/obsidian-cli)
//   --isolator       network | sync                          (default network)
//   --network        podman network                          (default obsidian-net)
//   --history        run a specific DSL string (else generate)
//   --scenario       random | stale                          (default random)
//   --ops            edit-count range "min-max" (or a single number for a fixed count) (default 6-12)
//   --notes          distinct notes per history              (default 1)
//   --turns          barrier | paced | concurrent            (default barrier)
//   --pause-prob     chance of a ~10s pause after an edit     (default 0)
//   --partition-prob chance per edit of a network partition   (default 0; needs 2+ nodes)
//   --repeat         reps per history                         (default 10)
//   --histories      number of histories to run (<=0 = until killed) (default 1)
//   --duration-min   run for N minutes instead of a count
//   --generate       print N generated histories and exit (no nodes touched)
//   --skip-host-check  skip the host-online preflight
//   --poll-sec / --min-floor-sec / --cap-sec / --w-settle-sec / --final-settle-sec  sync-wait tuning
//
// Mirrors all stdout to a timestamped log under runs/ (invocation as its first line).
//
//   npm run start -- --turns paced --partition-prob 0.4

import { existsSync, renameSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type Turns } from "./generator.js";
import { parse, serialize, type History } from "./dsl.js";
import { sleep } from "./runner.js";
import { hostOnline } from "./net.js";
import { NOTE_DIR } from "./types.js";

const { values } = parseArgs({
  options: {
    nodes: { type: "string" },
    bin: { type: "string" },
    network: { type: "string" },
    isolator: { type: "string" },
    scenario: { type: "string" },
    histories: { type: "string" },
    repeat: { type: "string" },
    "duration-min": { type: "string" },
    history: { type: "string" },
    ops: { type: "string" },
    notes: { type: "string" },
    turns: { type: "string" },
    "pause-prob": { type: "string" },
    "partition-prob": { type: "string" },
    generate: { type: "string" },
    "poll-sec": { type: "string" },
    "min-floor-sec": { type: "string" },
    "cap-sec": { type: "string" },
    "w-settle-sec": { type: "string" },
    "final-settle-sec": { type: "string" },
    "skip-host-check": { type: "boolean" },
  },
});

const nodesList = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim());
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
const network = values.network ?? "obsidian-net";
const isolatorKind = values.isolator ?? "network";
const scenario = values.scenario ?? "random";
const histories = Number(values.histories ?? 1);
const repeat = Number(values.repeat ?? 10);
const durationMin = Number(values["duration-min"] ?? 0);
const historyArg = values.history;

const opsRange = (values.ops ?? "6-12").split("-").map(Number);
const ops: [number, number] = [opsRange[0], opsRange[1] ?? opsRange[0]];
const turnsArg = values.turns ?? "barrier";
const turns = (["barrier", "paced", "concurrent"].includes(turnsArg) ? turnsArg : "barrier") as Turns;
const genParams: GenParams = {
  nodes: nodesList.length,
  ops,
  notes: Number(values.notes ?? 1),
  turns,
  pauseProb: Number(values["pause-prob"] ?? 0),
  partitionProb: Number(values["partition-prob"] ?? 0),
};

// --generate N: print N generated histories and exit — no nodes, no host check.
// (make echoes the full command; here we just emit the histories.)
const generateN = Number(values.generate ?? 0);
if (generateN > 0) {
  for (let i = 0; i < generateN; i++) {
    console.log(serialize(scenario === "stale" ? staleReconnect(genParams) : generateHistory(genParams)));
  }
  process.exit(0);
}

const execBase: Omit<ExecuteOpts, "noteName"> = {
  pollSec: Number(values["poll-sec"] ?? 1),
  minFloorSec: Number(values["min-floor-sec"] ?? 3),
  capSec: Number(values["cap-sec"] ?? 120),
  wSettleSec: Number(values["w-settle-sec"] ?? 4),
  finalSettleSec: Number(values["final-settle-sec"] ?? 6),
  hostCheck: !values["skip-host-check"], // on by default; --skip-host-check turns it off
};

const drivers = nodesList.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));
const byId = new Map(drivers.map((d) => [d.node, d]));
const isolator: Isolator = isolatorKind === "sync" ? new SyncToggleIsolator(byId) : new PodmanIsolator(network);

// Mirror all stdout to a timestamped log under runs/ so the console output (per-rep
// results, tally) is recoverable. The invocation is the log's first line (written to
// the file only — make already echoes the same command on the terminal).
mkdirSync("runs", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = historyArg ? "history" : `${turns}-ops${ops.join("-")}-rep${repeat}` + (genParams.partitionProb ? `-part${genParams.partitionProb}` : "");
const logPath = path.join("runs", `run-${stamp}-${slug}.log`);
appendFileSync(logPath, `npm run start -- ${process.argv.slice(2).join(" ")}\n`);
// Synchronous append so the tail (rep results, tally) survives process.exit().
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => { const line = args.map(String).join(" "); rawLog(line); appendFileSync(logPath, line + "\n"); };

console.log(`log: ${logPath}`);

let pass = 0;
let fail = 0;
let conflicts = 0;
const failures: string[] = [];
const startedAt = Date.now();

const tally = () =>
  `\n=== TALLY: PASS=${pass} FAIL=${fail} reps=${pass + fail}  (reps with any conflict: ${conflicts}) ===` +
  (failures.length ? "\nfailing reps:\n" + failures.map((f) => "  " + f).join("\n") : "");
process.on("SIGINT", () => {
  console.log(tally());
  process.exit(fail === 0 ? 0 : 1);
});

// Human-readable wall-clock stamp DDTHHMMSS (local time), e.g. 25T181530 — used for
// the history group dir (start ts) and each rep dir (its own ts). Day-of-month is
// enough granularity for a soak; collisions within a dir get a -k suffix.
const tsStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
function uniqueRepId(strDir: string): string {
  const base = tsStamp();
  let name = base;
  for (let k = 2; existsSync(path.join(strDir, name)); k++) name = `${base}-${k}`;
  return name;
}

// Any rep dir carrying one of these suffixes is a non-OK rep.
const FAIL_SUFFIXES = ["-UNSYNCED", "-TIMEOUT", "-LOST", "-DUPL", "-DIFF", "-FAIL"];
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isBadRep = (name: string) => FAIL_SUFFIXES.some((s) => name.endsWith(s));

/** After a history's reps, suffix the history dir with `-BAD<pct>` (percentage of
 *  non-OK reps) so it's eyeball-obvious where to dig; leave it clean if all passed.
 *  `groupName` is the dir's base name (`<ts0>-<history>`) so the suffix lands on it. */
function tagHistoryDir(strDir: string, groupName: string): void {
  if (!isDir(strDir)) return;
  const reps = readdirSync(strDir).filter((d) => isDir(path.join(strDir, d)));
  if (reps.length === 0) return;
  const bad = reps.filter(isBadRep).length;
  const target = bad > 0 ? path.join("runs", `${groupName}-BAD${Math.round((100 * bad) / reps.length)}`) : strDir;
  if (target !== strDir) { try { renameSync(strDir, target); } catch { /* keep */ } }
}

async function runRep(history: History, str: string, strDir: string): Promise<void> {
  const id = uniqueRepId(strDir);
  const logger = new RunLogger(strDir, id);
  logger.artifact("meta.json", {
    history: str,
    scenario,
    isolator: isolatorKind,
    turns: genParams.turns,
    partitionProb: genParams.partitionProb,
    notes: genParams.notes,
    ops: ops.join("-"),
    nodes: nodesList.length,
  });
  const noteName = (L: string) => `${NOTE_DIR}/${id}-${L}-${str}`;
  const { verdict, timings, forensics } = await runHistory(drivers, isolator, logger, history, { ...execBase, noteName });

  const lost = verdict.notes.flatMap((n) => n.lost);
  const duplicated = verdict.notes.flatMap((n) => n.duplicated);
  const diverged = verdict.notes.some((n) => !n.converged);
  const conflictFiles = Math.max(0, ...verdict.notes.map((n) => n.conflictFiles));
  const onlyInConflict = verdict.notes.reduce((s, n) => s + n.onlyInConflict.length, 0);
  if (conflictFiles > 0 || onlyInConflict > 0) conflicts++;

  // A clean PASS requires the token oracle happy AND a conclusive settle: a note
  // that never reached the server (unsynced) or a settle that never quiesced before
  // the cap (syncTimedOut) is not a pass — the latter is inconclusive, not trusted.
  if (verdict.ok && !timings.unsynced && !timings.syncTimedOut) {
    pass++;
    const tag = conflictFiles || onlyInConflict ? ` conflict(files=${conflictFiles})` : "";
    console.log(`  rep ${id}: PASS${tag} conv=${timings.convergenceSec}s total=${timings.totalSec}s`);
  } else {
    fail++;
    // Ranked, most-severe-first: never-synced > inconclusive timeout > real loss >
    // duplication > divergence. -FAIL is a catch-all that should never fire.
    const suffix =
      timings.unsynced ? "-UNSYNCED"
      : timings.syncTimedOut ? "-TIMEOUT"
      : lost.length ? "-LOST"
      : duplicated.length ? "-DUPL"
      : diverged ? "-DIFF"
      : "-FAIL";
    let dir = logger.dir;
    try { renameSync(logger.dir, logger.dir + suffix); dir = logger.dir + suffix; } catch { /* keep original */ }
    failures.push(dir);
    const dropped = forensics.filter((f) => f.serverRecoverable).length;
    const unregistered = forensics.length - dropped;
    console.log(`  rep ${id}: *** ${suffix.slice(1)} *** lost=${lost.length} dup=${duplicated.length} (server-dropped=${dropped}, never-registered=${unregistered}) total=${timings.totalSec}s → ${path.basename(dir)}`);
  }
}

async function runHistoryReps(history: History): Promise<void> {
  const str = serialize(history);
  // Group dir carries the history's start ts, so each invocation is its own timestamped
  // dir (re-runs don't merge); rep subdirs inside carry their own ts.
  const groupName = `${tsStamp()}-${str}`;
  const strDir = path.join("runs", groupName);
  console.log(`\n=== history ${str}  (×${repeat}) ===`);
  for (let r = 0; r < repeat; r++) await runRep(history, str, strDir);
  tagHistoryDir(strDir, groupName);
}

const keepGoing = (h: number) =>
  durationMin > 0 ? Date.now() - startedAt < durationMin * 60_000 : histories <= 0 ? true : h < histories;

// Confirm the host itself has connectivity before blaming Sync for anything — a host
// outage would otherwise masquerade as data loss. (`hostOnline` lives in net.ts so the
// settle loop in execute.ts can reuse it.) --skip-host-check bypasses (e.g. a sandboxed
// environment that blocks outbound TCP).
if (!values["skip-host-check"] && !(await hostOnline())) {
  console.error("host appears OFFLINE (can't reach 8.8.8.8:53) — aborting so a host outage isn't mistaken for Sync loss. Pass --skip-host-check to override.");
  process.exit(2);
}

// Standard pre-run check: resume Sync, wait (bounded) for a settled baseline, then
// gate the run on it being sane — every node reachable, `synced`, and agreeing on
// note count. Otherwise we abort rather than soak against a bad baseline (which would
// manufacture false losses/divergence).
type PreflightRow = { node: string; reachable: boolean; state: string; notes: number };
async function readState(d: ObsidianDriver): Promise<PreflightRow> {
  const st = await d.syncStatus();
  const state = st.ok ? (/^status:\s*(\S+)/m.exec(st.value ?? "")?.[1] ?? "?") : "unreachable";
  const files = await d.listFiles();
  const notes = st.ok && files.ok ? (files.value?.length ?? 0) : -1;
  return { node: d.node, reachable: st.ok, state, notes };
}

async function preflight(): Promise<boolean> {
  // The harness always runs with Sync ON (network is the only isolation layer), and a
  // fresh `make containers-up` brings nodes up with Sync PAUSED. Resume first — else a
  // perfectly normal just-started node reads as "unhealthy" — then wait for it to
  // settle before judging.
  for (const d of drivers) await d.syncResume();

  // Wait until every node is `synced` (or something is clearly wrong) before trusting
  // a count comparison: during the initial sync, note counts legitimately differ.
  const cap = execBase.capSec ?? 120;
  const deadline = Date.now() + cap * 1000;
  let rows = await Promise.all(drivers.map(readState));
  while (
    rows.every((r) => r.reachable) &&
    !rows.some((r) => r.state === "error") &&
    !rows.every((r) => r.state === "synced") &&
    Date.now() < deadline
  ) {
    await sleep(2000);
    rows = await Promise.all(drivers.map(readState));
  }
  for (const r of rows) console.log(`preflight ${r.node}: status=${r.state} notes=${r.notes}`);

  // An unreachable node can't be soaked against at all.
  if (rows.some((r) => !r.reachable)) {
    console.log("preflight FAILED — a node is unreachable (is `make containers-up` done?). Aborting.");
    return false;
  }
  // A node that won't reach `synced` (stuck `error`, or still `syncing`/paused past the
  // cap) is a sick baseline — soaking on it just burns reps into -TIMEOUTs. Abort so
  // it's recreated/healed first rather than silently degrading the run.
  const unhealthy = rows.filter((r) => r.state !== "synced");
  if (unhealthy.length > 0) {
    console.log(`preflight UNHEALTHY: node(s) not synced after ${cap}s (${unhealthy.map((r) => `${r.node}:${r.state}`).join(" ")}) — recreate with 'make containers-up' (or wait for recovery); aborting.`);
    return false;
  }
  // All synced now, so a note-count disagreement is real divergence, not lag.
  if (new Set(rows.map((r) => r.notes)).size > 1) {
    const detail = rows.map((r) => `${r.node}=${r.notes}`).join(" ");
    console.log(`preflight DIVERGENT: synced nodes disagree on note count (${detail}) — run 'make clean-data' or investigate; aborting.`);
    return false;
  }
  return true;
}

if (!(await preflight())) process.exit(2);

if (historyArg) {
  await runHistoryReps(parse(historyArg));
} else {
  for (let h = 0; keepGoing(h); h++) {
    const history = scenario === "stale" ? staleReconnect(genParams) : generateHistory(genParams);
    await runHistoryReps(history);
  }
}

console.log(tally());
process.exit(fail === 0 ? 0 : 1);
