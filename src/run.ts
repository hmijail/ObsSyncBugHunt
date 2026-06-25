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
//   --ops            edit-count range "min-max"              (default 6-12)
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
import net from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type Turns } from "./generator.js";
import { parse, serialize, type History } from "./dsl.js";
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

const epoch6 = () => String(Math.floor(Date.now() / 1000)).slice(-6);
function uniqueRepId(strDir: string): string {
  const base = epoch6();
  let name = base;
  for (let k = 2; existsSync(path.join(strDir, name)); k++) name = `${base}-${k}`;
  return name;
}

// Any rep dir carrying one of these suffixes is a non-OK rep.
const FAIL_SUFFIXES = ["-UNSYNCED", "-TIMEOUT", "-LOST", "-DUPL", "-DIFF", "-FAIL"];
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isBadRep = (name: string) => FAIL_SUFFIXES.some((s) => name.endsWith(s));

/** Re-runs fold an existing `runs/<str>-BAD<pct>` back to the clean `runs/<str>`
 *  so new reps accumulate and the percentage is recomputed over the full set. */
function cleanStrDir(str: string): string {
  const clean = path.join("runs", str);
  if (!existsSync(clean) && existsSync("runs")) {
    const re = new RegExp(`^${str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-BAD\\d+$`);
    const prev = readdirSync("runs").find((d) => re.test(d) && isDir(path.join("runs", d)));
    if (prev) renameSync(path.join("runs", prev), clean);
  }
  return clean;
}

/** After a history's reps, suffix the history dir with `-BAD<pct>` (percentage of
 *  non-OK reps) so it's eyeball-obvious where to dig; leave it clean if all passed. */
function tagHistoryDir(strDir: string, str: string): void {
  if (!isDir(strDir)) return;
  const reps = readdirSync(strDir).filter((d) => isDir(path.join(strDir, d)));
  if (reps.length === 0) return;
  const bad = reps.filter(isBadRep).length;
  const target = bad > 0 ? path.join("runs", `${str}-BAD${Math.round((100 * bad) / reps.length)}`) : strDir;
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
  const noteName = (L: string) => `${NOTE_DIR}/${id}-${str}-${L}`;
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
  const strDir = cleanStrDir(str);
  console.log(`\n=== history ${str}  (×${repeat}) ===`);
  for (let r = 0; r < repeat; r++) await runRep(history, str, strDir);
  tagHistoryDir(strDir, str);
}

const keepGoing = (h: number) =>
  durationMin > 0 ? Date.now() - startedAt < durationMin * 60_000 : histories <= 0 ? true : h < histories;

// Confirm the host itself has connectivity before blaming Sync for anything — a
// host outage would otherwise masquerade as data loss. --skip-host-check bypasses
// (e.g. a sandboxed environment that blocks outbound TCP).
function hostOnline(host = "8.8.8.8", port = 53, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

if (!values["skip-host-check"] && !(await hostOnline())) {
  console.error("host appears OFFLINE (can't reach 8.8.8.8:53) — aborting so a host outage isn't mistaken for Sync loss. Pass --skip-host-check to override.");
  process.exit(2);
}

// Standard pre-run check: log each node's sync state + vault note count, and gate
// the run on every node being reachable (otherwise the findings are logged and we
// abort rather than soak against a bad baseline).
async function preflight(): Promise<boolean> {
  let ok = true;
  for (const d of drivers) {
    const st = await d.syncStatus();
    const state = st.ok ? (/^status:\s*(\S+)/m.exec(st.value ?? "")?.[1] ?? "?") : "unreachable";
    const files = await d.listFiles();
    const notes = st.ok && files.ok ? (files.value?.length ?? 0) : -1;
    console.log(`preflight ${d.node}: status=${state} notes=${notes}`);
    if (!st.ok) ok = false;
  }
  return ok;
}

if (!(await preflight())) {
  console.log("preflight FAILED — a node is unreachable (is `make containers-up` done?). Aborting.");
  process.exit(2);
}

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
