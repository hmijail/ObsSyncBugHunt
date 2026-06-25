// Test entrypoint: generates (or takes) a DSL history, runs it REPEAT times
// against the containerized nodes, and tallies. Each history string is a
// directory; each repeat is a sub-run named by epoch6. A non-OK rep dir is
// suffixed -UNSYNCED / -TIMEOUT / -LOST / -DUPL / -DIFF, and a history dir gets
// -BAD<pct> (share of non-OK reps). Env vars:
//
//   NODES        comma-separated container names          (default "n1,n2")
//   OBSIDIAN_BIN CLI path inside the container            (default "/opt/obsidian/obsidian-cli")
//   ISOLATOR     "network" | "sync"                       (default "network")
//   NETWORK      podman network                           (default "obsidian-net")
//   HISTORY      run a specific DSL string (else generate)
//   SCENARIO     "random" | "stale"                       (default "random")
//   OPS          edit-count range "min-max"               (default "6-12")
//   NOTES        distinct notes per history               (default 1)
//   TURNS        barrier | paced | concurrent             (default barrier)
//   PAUSE_PROB   chance of a ~10s pause after an edit      (default 0)
//   PARTITION_PROB chance per edit of a network partition  (default 0; needs 2+ nodes)
//   REPEAT       reps per history                          (default 10)
//   CAMPAIGN     number of histories (<=0 = until killed) (default 1)
//   DURATION_MIN run for N minutes instead of a count
//   GENERATE     print N generated histories and exit (no nodes touched)
//   POLL_SEC / MIN_FLOOR_SEC / CAP_SEC / W_SETTLE_SEC / FINAL_SETTLE_SEC   sync-wait tuning
//
// Prints a copy-pasteable invocation line, and mirrors all stdout to a timestamped
// log under runs/.
//
//   npm run start

import { existsSync, renameSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PodmanExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type Turns } from "./generator.js";
import { parse, serialize, type History } from "./dsl.js";

const flag = (v: string | undefined) => v === "1" || v === "true";

const nodesList = (process.env.NODES ?? "n1,n2").split(",").map((s) => s.trim());
const bin = process.env.OBSIDIAN_BIN ?? "/opt/obsidian/obsidian-cli";
const network = process.env.NETWORK ?? "obsidian-net";
const isolatorKind = process.env.ISOLATOR ?? "network";
const scenario = process.env.SCENARIO ?? "random";
const campaign = Number(process.env.CAMPAIGN ?? 1);
const repeat = Number(process.env.REPEAT ?? 10);
const durationMin = Number(process.env.DURATION_MIN ?? 0);
const historyEnv = process.env.HISTORY;

const opsRange = (process.env.OPS ?? "6-12").split("-").map(Number);
const ops: [number, number] = [opsRange[0], opsRange[1] ?? opsRange[0]];
const turnsEnv = process.env.TURNS ?? "barrier";
const turns = (["barrier", "paced", "concurrent"].includes(turnsEnv) ? turnsEnv : "barrier") as Turns;
const genParams: GenParams = {
  nodes: nodesList.length,
  ops,
  notes: Number(process.env.NOTES ?? 1),
  turns,
  pauseProb: Number(process.env.PAUSE_PROB ?? 0),
  partitionProb: Number(process.env.PARTITION_PROB ?? 0),
};
// GENERATE=N: just print N generated histories and exit — no nodes, no host check.
const generateN = Number(process.env.GENERATE ?? 0);
if (generateN > 0) {
  for (let i = 0; i < generateN; i++) {
    console.log(serialize(scenario === "stale" ? staleReconnect(genParams) : generateHistory(genParams)));
  }
  process.exit(0);
}

const execBase: Omit<ExecuteOpts, "noteName"> = {
  pollSec: Number(process.env.POLL_SEC ?? 1),
  minFloorSec: Number(process.env.MIN_FLOOR_SEC ?? 3),
  capSec: Number(process.env.CAP_SEC ?? 120),
  wSettleSec: Number(process.env.W_SETTLE_SEC ?? 4),
  finalSettleSec: Number(process.env.FINAL_SETTLE_SEC ?? 6),
};

const drivers = nodesList.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin)));
const byId = new Map(drivers.map((d) => [d.node, d]));
const isolator: Isolator = isolatorKind === "sync" ? new SyncToggleIsolator(byId) : new PodmanIsolator(network);

// Mirror all stdout to a timestamped log under runs/ so the console output (params
// line, per-rep results, tally) is recoverable, not just live on the terminal.
mkdirSync("runs", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const slug = historyEnv ? "history" : `${turns}-ops${ops.join("-")}-rep${repeat}` + (genParams.partitionProb ? `-part${genParams.partitionProb}` : "");
const logPath = path.join("runs", `run-${stamp}-${slug}.log`);
// Synchronous append so the tail (rep results, tally) survives process.exit().
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => { const line = args.map(String).join(" "); rawLog(line); appendFileSync(logPath, line + "\n"); };

// A copy-pasteable invocation that reproduces this run.
const invocation = [
  `NODES=${nodesList.join(",")}`,
  isolatorKind !== "network" ? `ISOLATOR=${isolatorKind}` : "",
  historyEnv ? `HISTORY=${historyEnv}` : `SCENARIO=${scenario} OPS=${ops.join("-")} NOTES=${genParams.notes} TURNS=${turns}`,
  genParams.pauseProb ? `PAUSE_PROB=${genParams.pauseProb}` : "",
  genParams.partitionProb ? `PARTITION_PROB=${genParams.partitionProb}` : "",
  `REPEAT=${repeat}`,
  durationMin > 0 ? `DURATION_MIN=${durationMin}` : `CAMPAIGN=${campaign}`,
  "npm run start",
].filter(Boolean).join(" ");
console.log(invocation);
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
  const noteName = (L: string) => `${id}-${str}-${L}`;
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
  durationMin > 0 ? Date.now() - startedAt < durationMin * 60_000 : campaign <= 0 ? true : h < campaign;

// Confirm the host itself has connectivity before blaming Sync for anything — a
// host outage would otherwise masquerade as data loss. SKIP_HOST_CHECK=1 bypasses
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

if (!flag(process.env.SKIP_HOST_CHECK) && !(await hostOnline())) {
  console.error("host appears OFFLINE (can't reach 8.8.8.8:53) — aborting so a host outage isn't mistaken for Sync loss. Set SKIP_HOST_CHECK=1 to override.");
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
  console.log("preflight FAILED — a node is unreachable (is `make up` done?). Aborting.");
  process.exit(2);
}

if (historyEnv) {
  await runHistoryReps(parse(historyEnv));
} else {
  for (let h = 0; keepGoing(h); h++) {
    const history = scenario === "stale" ? staleReconnect(genParams) : generateHistory(genParams);
    await runHistoryReps(history);
  }
}

console.log(tally());
process.exit(fail === 0 ? 0 : 1);
