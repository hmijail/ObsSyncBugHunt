// Test entrypoint: generates (or takes) a DSL history, runs it REPEAT times
// against the containerized nodes, and tallies. Each history string is a
// directory; each repeat is a sub-run named by epoch6. A non-OK rep dir is
// suffixed -NOUPLOAD / -TIMEOUT / -LOST / -DUPL / -SYNCBAD (verdict outcomes) or
// -OBSFAIL / -UNKNOWN (a caught alarm-class condition — see alarm.ts), and a
// history dir gets -BAD<pct> (share of non-OK reps).
//
// Params are CLI args (args-only — env is not read). Use `make` (which maps
// `make soak TURNS=paced` to the flags below), or run directly: `npm run start -- <flags>`.
//
//   --nodes          comma-separated container names, plus the literal "mac" to include the Mac
//                    node — e.g. "n1,n2,mac" (default n1,n2). "mac" is the sole on/off switch for
//                    the DSL's `M` node (a real, always-connected local instance; never a D/C
//                    target, see dsl.ts) — --mac-bin only supplies its binary path, so "mac" in
//                    --nodes without --mac-bin/MAC_BIN set fails fast at startup rather than
//                    crashing mid-run (and vice versa: a history using `M` without "mac" in
//                    --nodes also fails fast). Its Sync state is also checked before every op it
//                    performs (paused/error/stopped/offline aborts the whole run — see execute.ts's
//                    assertMacSyncOn); its vault path is self-reported (`vault info=path`), which
//                    enables the same FS cross-check the containers get, with nothing to configure.
//   --bin            CLI path inside the container           (default /opt/obsidian/obsidian-cli)
//   --isolator       network | sync                          (default network)
//   --network        podman network                          (default obsidian-net)
//   --mac-bin        path to a local obsidian-cli binary (NOT the GUI Obsidian binary — the CLI
//                    is much faster per-call) — only used if "mac" is in --nodes; see above
//   --mac-node-id    the Mac's own Sync-reported device name (default: OS `hostname`, which
//                    is a guess, not verified to match — see run.ts's own comment on this)
//   --history        run a specific DSL string (else generate)
//   --steps          with --history: run only its first N ops (prefix, for shrinking a finding)
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
//   --vault-path     vault's on-disk root for the FS cross-check (default /root/vaults/TestVault)
//   --poll-sec / --min-floor-sec / --cap-sec / --w-settle-sec / --final-settle-sec  sync-wait tuning
//   --probe-sec      per-call cap on the settle's sync:status probe (default 5; it blocks until synced)
//   --runs-prefix    parent dir for runs/ (default: cwd, i.e. plain ./runs)
//   --skip-snapshot-timing  omit the pause-snapshot's per-call `ms` fields (debug aid, on by default)
//
// Mirrors all stdout to a timestamped log under runs/ (invocation as its first line).
//
//   npm run start -- --turns paced --partition-prob 0.4

import { existsSync, renameSync, readdirSync, statSync, mkdirSync, appendFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { parseArgs } from "node:util";
import { PodmanExecutor, LocalExecutor, runProcess } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { SyncToggleIsolator, PodmanIsolator, type Isolator } from "./isolate.js";
import { RunLogger } from "./history.js";
import { runHistory, type ExecuteOpts } from "./execute.js";
import { generateHistory, staleReconnect, type GenParams, type Turns } from "./generator.js";
import { parse, serialize, normalize, usesMac, type History } from "./dsl.js";
import { sleep } from "./runner.js";
import { hostOnline } from "./net.js";
import { CliUnrecognizedOutput } from "./cli-parse.js";
import { AlarmError, describeAlarm, recordAlarm } from "./alarm.js";
import { NOTE_DIR } from "./types.js";

// Correctness-assumption violations are thrown deep in the driver/oracle; they're handled
// per-rep in `runRep` (tagged -OBSFAIL/-UNKNOWN, soak continues). One that still escapes the
// rep loop — e.g. preflight against an unparseable baseline — has no rep to attach to, so we
// record it durably, print the compact diagnostic (copy-paste command + file:line), and exit.
// Other errors keep the normal crash behavior.
for (const ev of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(ev, (err: unknown) => {
    if (err instanceof AlarmError || err instanceof CliUnrecognizedOutput) {
      const d = describeAlarm(err);
      recordAlarm(d, runsRoot);
      console.error(`*** ${d.suffix.slice(1)} (outside a rep) *** ${d.reason}${d.recognizer ? ` (recognizer: ${d.recognizer})` : ""}${d.site ? ` @ ${d.site}` : ""}${d.command ? `\n  cmd: ${d.command}` : ""}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

const { values } = parseArgs({
  options: {
    nodes: { type: "string" },
    bin: { type: "string" },
    network: { type: "string" },
    isolator: { type: "string" },
    "mac-bin": { type: "string" },
    "mac-node-id": { type: "string" },
    scenario: { type: "string" },
    histories: { type: "string" },
    repeat: { type: "string" },
    "duration-min": { type: "string" },
    history: { type: "string" },
    steps: { type: "string" },
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
    "probe-sec": { type: "string" },
    "skip-host-check": { type: "boolean" },
    "vault-path": { type: "string" },
    "runs-prefix": { type: "string" },
    "skip-snapshot-timing": { type: "boolean" },
  },
});

// "mac" in --nodes is the sole on/off switch for Mac participation — --mac-bin only supplies its
// binary path (see the header comment above for why this reads more naturally than a separate flag).
const rawNodes = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim());
const macRequested = rawNodes.includes("mac");
const nodesList = rawNodes.filter((n) => n !== "mac"); // container names only, from here on
const bin = values.bin ?? "/opt/obsidian/obsidian-cli";
const network = values.network ?? "obsidian-net";
const isolatorKind = values.isolator ?? "network";
const macBin = values["mac-bin"];
if (macRequested && !macBin) {
  console.error(`--nodes/NODES includes "mac" but --mac-bin/MAC_BIN wasn't provided — pass --mac-bin <path> or drop "mac" from --nodes.`);
  process.exit(2);
}
const scenario = values.scenario ?? "random";
const histories = Number(values.histories ?? 1);
const repeat = Number(values.repeat ?? 10);
const durationMin = Number(values["duration-min"] ?? 0);
const historyArg = values.history;
const steps = Number(values.steps ?? 0); // with --history: run only its first N ops (0 = all)

// Normalize a hand-typed --history up front (before any container is touched) so an `M` used
// without "mac" in --nodes fails fast with a clear message instead of crashing deep in
// runHistory: the DSL grammar accepts `M` regardless of whether the Mac is actually wired up, so
// nothing else catches this mismatch.
const parsedHistory = historyArg ? normalize(parse(historyArg)) : undefined;
if (parsedHistory && !macRequested && usesMac(parsedHistory)) {
  console.error(`history "${historyArg}" uses M (the Mac node) but "mac" isn't in --nodes/NODES — add it (e.g. --nodes ${[...nodesList, "mac"].join(",")}) or remove M from the history.`);
  process.exit(2);
}

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
  macEnabled: macRequested,
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

// The CLI's own self-report (`<bin> version`), not a build-time assumption — reflects
// whatever's actually installed, queried once so every rep's `history` event can record
// exactly which Obsidian build produced its result (a bug can appear/vanish across releases).
async function obsidianVersion(): Promise<string> {
  const r = await runProcess("podman", ["exec", nodesList[0], bin, "version"]);
  return r.stdout.trim() || "?";
}

// Same idea for the Mac, queried directly (no podman wrapping — same construction as
// LocalExecutor.exec) — worth recording separately since a real reason to test against a real
// Mac is likely a DIFFERENT installed version than the containers' pinned build.
async function macObsidianVersion(): Promise<string | undefined> {
  if (!macRequested) return undefined;
  const r = await runProcess(macBin!, ["version"]);
  return r.stdout.trim() || "?";
}

// The Mac's own vault root, self-reported (`obsidian-cli vault info=path`) — enables the same
// CLI-vs-filesystem cross-check the containers get, with no manual path to configure or keep in
// sync with wherever the user's real vault happens to live.
async function macVaultPath(): Promise<string | undefined> {
  if (!macRequested) return undefined;
  const r = await runProcess(macBin!, ["vault", "info=path"]);
  return r.stdout.trim() || undefined;
}

// Parent dir for the whole runs/ tree — lets a soak's artifacts live somewhere other than the
// cwd (e.g. a bigger disk). Default (no flag) keeps today's behavior: plain "runs".
const runsRoot = values["runs-prefix"] ? path.join(values["runs-prefix"], "runs") : "runs";

// Vault's on-disk root in the container — enables the filesystem second-source / CLI-vs-FS
// cross-check (see docs/cli-trust.md). Override with --vault-path if the image differs.
const vaultPath = values["vault-path"] ?? "/root/vaults/TestVault";
const drivers = nodesList.map((n) => new ObsidianDriver(new PodmanExecutor(n, bin), vaultPath));
if (macRequested) {
  // The Mac's own Sync-reported device name — oracle.ts's conflict-file `wellFormed` check
  // matches the parsed `(Conflicted copy <device> ...)` name against each driver's own `.node`,
  // so this has to be what Sync itself calls the device, not an arbitrary label. `hostname` is
  // a reasonable GUESS, not verified to match (e.g. a `.local` suffix hostname includes that
  // Sync's own naming may not) — override with --mac-node-id if a real conflict later shows a
  // mismatch (wellFormed is informational only, so this doesn't gate the core token oracle).
  const macNodeId = values["mac-node-id"] ?? (await runProcess("hostname", [])).stdout.trim();
  drivers.push(new ObsidianDriver(new LocalExecutor(macBin!, macNodeId), await macVaultPath()));
}
const byId = new Map(drivers.map((d) => [d.node, d]));
const isolator: Isolator = isolatorKind === "sync" ? new SyncToggleIsolator(byId) : new PodmanIsolator(network);

const execBase: Omit<ExecuteOpts, "noteName"> = {
  pollSec: Number(values["poll-sec"] ?? 1),
  minFloorSec: Number(values["min-floor-sec"] ?? 3),
  capSec: Number(values["cap-sec"] ?? 120),
  wSettleSec: Number(values["w-settle-sec"] ?? 4),
  finalSettleSec: Number(values["final-settle-sec"] ?? 15),
  probeSec: Number(values["probe-sec"] ?? 5),
  hostCheck: !values["skip-host-check"], // on by default; --skip-host-check turns it off
  snapshotTiming: !values["skip-snapshot-timing"], // on by default; --skip-snapshot-timing turns it off
  isolator: isolatorKind,
  obsidianVersion: await obsidianVersion(),
  macNode: macRequested ? drivers.length : undefined, // the Mac driver's own (last) position
  macObsidianVersion: await macObsidianVersion(),
};

// Human-readable wall-clock stamp DDTHHMMSS (local time), e.g. 25T181530 — used for both the
// run log filename below and each rep/history-group dir (see uniqueRepId), so they share one
// timestamp convention. Day-of-month is enough granularity for a soak; collisions within a dir
// get a -k suffix (see uniqueRepId).
const tsStamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Mirror all stdout to a timestamped log under runs/ so the console output (per-rep
// results, tally) is recoverable. The invocation is the log's first line (written to
// the file only — make already echoes the same command on the terminal).
mkdirSync(runsRoot, { recursive: true });
const slug = historyArg ? "history" : `${turns}-ops${ops.join("-")}-rep${repeat}` + (genParams.partitionProb ? `-part${genParams.partitionProb}` : "");
const logPath = path.join(runsRoot, `${tsStamp()}-${slug}.log`);
appendFileSync(logPath, `npm run start -- ${process.argv.slice(2).join(" ")}\n`);
// Synchronous append so the tail (rep results, tally) survives process.exit().
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => { const line = args.map(String).join(" "); rawLog(line); appendFileSync(logPath, line + "\n"); };

console.log(`log: ${logPath}`);

let pass = 0;
let fail = 0; // real oracle failures (NOUPLOAD/TIMEOUT/LOST/DUPL/SYNCBAD)
let obsfail = 0; // client misreported its vault (-OBSFAIL)
let unknown = 0; // couldn't judge — unparseable/unresponsive CLI, or ladder catch-all (-UNKNOWN)
let conflicts = 0;
const failures: string[] = [];
const startedAt = Date.now();
// The group dir currently accruing reps, so a Ctrl-C mid-soak can still tag it with -BAD<pct>
// (tagHistoryDir is normally only called after a reps loop finishes on its own).
let activeGroup: { strDir: string; groupName: string } | null = null;

const nonOk = () => fail + obsfail + unknown;
const tally = () =>
  `\n=== TALLY: PASS=${pass} FAIL=${fail} OBSFAIL=${obsfail} UNKNOWN=${unknown} reps=${pass + nonOk()}  (reps with any conflict: ${conflicts}) ===` +
  (failures.length ? "\nfailing reps:\n" + failures.map((f) => "  " + f).join("\n") : "");

// Permanent bottom status bar, TTY only. We reserve the last terminal row with a VT100
// scroll region (DECSTBM) so the scrolling trace never overwrites it, and repaint the
// row with the running tally as it changes. Escapes go straight to stdout (not through
// the console.log override) so they never reach the run-log file. All no-ops when stdout
// isn't a terminal (piped / background), leaving only the per-rep tally line.
const isTTY = process.stdout.isTTY === true;
const statusLine = () =>
  `soak: ${pass + nonOk()} reps · ${pass} passed · ${fail} failed · ${obsfail} obsfail · ${unknown} unknown` +
  (failures.length ? ` · last ${path.basename(failures[failures.length - 1])}` : "");
function drawStatus(): void {
  const rows = process.stdout.rows ?? 0;
  if (!isTTY || rows < 2) return;
  // save cursor, go to last row, clear it, reverse-video line, restore cursor
  process.stdout.write(`\x1b7\x1b[${rows};1H\x1b[2K\x1b[7m ${statusLine()} \x1b[0m\x1b8`);
}
function statusBarOn(): void {
  const rows = process.stdout.rows ?? 0;
  if (!isTTY || rows < 2) return;
  process.stdout.write(`\x1b[1;${rows - 1}r\x1b[${rows - 1};1H`); // reserve last row, cursor above it
  drawStatus();
}
function statusBarOff(): void {
  const rows = process.stdout.rows ?? 0;
  if (!isTTY || rows < 2) return;
  process.stdout.write(`\x1b[r\x1b[${rows};1H\x1b[2K`); // release scroll region, clear the bar
}
if (isTTY) process.stdout.on("resize", statusBarOn); // re-reserve on terminal resize
process.on("exit", statusBarOff);

process.on("SIGINT", () => {
  statusBarOff();
  if (activeGroup) tagHistoryDir(activeGroup.strDir, activeGroup.groupName);
  console.log(tally());
  process.exit(nonOk() === 0 ? 0 : 1);
});

function uniqueRepId(strDir: string): string {
  const base = tsStamp();
  let name = base;
  for (let k = 2; existsSync(path.join(strDir, `${name}.jsonl`)); k++) name = `${base}-${k}`;
  return name;
}

// Any rep file carrying one of these suffixes (just before .jsonl) is a non-OK rep.
const FAIL_SUFFIXES = ["-NOUPLOAD", "-TIMEOUT", "-LOST", "-DUPL", "-SYNCBAD", "-OBSFAIL", "-UNKNOWN"];
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isBadRep = (name: string) => FAIL_SUFFIXES.some((s) => name.endsWith(`${s}.jsonl`));

/** Rename a rep's `.jsonl` file to carry an outcome suffix (e.g. `-LOST`), inserted just
 *  before the extension. Returns the new path, or the original if the rename failed. */
function tagRep(repPath: string, suffix: string): string {
  const tagged = repPath.replace(/\.jsonl$/, `${suffix}.jsonl`);
  try { renameSync(repPath, tagged); return tagged; } catch { return repPath; }
}

/** After a history's reps, suffix the history dir with `-BAD<pct>` (percentage of
 *  non-OK reps) so it's eyeball-obvious where to dig; leave it clean if all passed.
 *  `groupName` is the dir's base name (`<ts0>-<history>`) so the suffix lands on it. */
function tagHistoryDir(strDir: string, groupName: string): void {
  if (!isDir(strDir)) return;
  const reps = readdirSync(strDir).filter((f) => f.endsWith(".jsonl"));
  if (reps.length === 0) return;
  const bad = reps.filter(isBadRep).length;
  const target = bad > 0 ? path.join(runsRoot, `${groupName}-BAD${Math.round((100 * bad) / reps.length)}`) : strDir;
  if (target !== strDir) { try { renameSync(strDir, target); } catch { /* keep */ } }
}

async function runRep(history: History, str: string, strDir: string): Promise<void> {
  const id = uniqueRepId(strDir);
  console.log(`  rep ${id}  (running: ${nonOk()}/${pass + nonOk()} failed)`);
  drawStatus();
  const logger = new RunLogger(strDir, id);
  const noteName = (L: string) => `${NOTE_DIR}/${id}-${L}-${str}`;

  // A correctness-assumption violation (unparseable CLI output, a wedged CLI, or a client
  // that misreports its own vault) is thrown deep in the driver/oracle. Catch it HERE — the
  // single place every rep funnels through — so it becomes just another rep outcome
  // (-UNKNOWN / -OBSFAIL) and the soak keeps running, with enough logged to iterate on it.
  let outcome: Awaited<ReturnType<typeof runHistory>>;
  try {
    outcome = await runHistory(drivers, isolator, logger, history, { ...execBase, noteName });
  } catch (err) {
    if (!(err instanceof AlarmError || err instanceof CliUnrecognizedOutput)) throw err; // a real crash
    const d = describeAlarm(err);
    recordAlarm(d, runsRoot);
    logger.log({ kind: d.category, ...d });
    const repPath = tagRep(logger.path, d.suffix);
    failures.push(repPath);
    if (d.category === "obsfail") obsfail++; else unknown++;
    console.log(
      `  rep ${id}: *** ${d.suffix.slice(1)} *** ${d.reason}${d.recognizer ? ` (recognizer: ${d.recognizer})` : ""}${d.site ? ` @ ${d.site}` : ""}` +
      `${d.command ? `\n    cmd: ${d.command}` : ""}${d.stdout !== undefined ? `\n    out: ${JSON.stringify(d.stdout)}` : ""}` +
      ` → ${path.basename(repPath)}`,
    );
    drawStatus();
    return;
  }
  const { verdict, timings, forensics } = outcome;

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
    // Ranked, most-severe-first: never-uploaded > inconclusive timeout > real loss >
    // duplication > divergence. -UNKNOWN is a catch-all that should never fire here (a true
    // "couldn't judge"); it's counted as `unknown`, the rest as real oracle failures.
    const suffix =
      timings.unsynced ? "-NOUPLOAD"
      : timings.syncTimedOut ? "-TIMEOUT"
      : lost.length ? "-LOST"
      : duplicated.length ? "-DUPL"
      : diverged ? "-SYNCBAD"
      : "-UNKNOWN";
    assert(FAIL_SUFFIXES.includes(suffix), `verdict suffix ${suffix} is a known outcome`);
    if (suffix === "-UNKNOWN") unknown++; else fail++;
    const repPath = tagRep(logger.path, suffix);
    failures.push(repPath);
    const dropped = forensics.filter((f) => f.serverRecoverable).length;
    const unregistered = forensics.length - dropped;
    console.log(`  rep ${id}: *** ${suffix.slice(1)} *** lost=${lost.length} dup=${duplicated.length} (server-dropped=${dropped}, never-registered=${unregistered}) total=${timings.totalSec}s → ${path.basename(repPath)}`);
  }
  drawStatus(); // refresh the bar with the updated tally
}

async function runHistoryReps(history: History): Promise<void> {
  const str = serialize(history);
  // Group dir carries the history's start ts, so each invocation is its own timestamped
  // dir (re-runs don't merge); rep subdirs inside carry their own ts.
  const groupName = `${tsStamp()}-${str}`;
  const strDir = path.join(runsRoot, groupName);
  activeGroup = { strDir, groupName };
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
  try {
    const st = await d.syncStatus(); // validated status word (throws on unknown)
    const files = await d.listFiles();
    return { node: d.node, reachable: true, state: st.value ?? "?", notes: files.value?.length ?? 0 };
  } catch (e) {
    // A down/absent container fails at the exec layer (podman exit ≠ 0, empty stdout) →
    // report unreachable so preflight aborts with a friendly message. A *code-0* unknown
    // output is a real format problem, not a down node — let it propagate to the ALARM.
    if (e instanceof CliUnrecognizedOutput && e.raw.code !== 0) {
      return { node: d.node, reachable: false, state: "unreachable", notes: -1 };
    }
    throw e;
  }
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

statusBarOn(); // reserve the bottom status row (TTY only) now that the trace starts in earnest

if (historyArg) {
  // A given history accrues ALL its reps in ONE group dir. `make run` does REPEAT reps;
  // `make soak HISTORY=X` (histories<=0) or DURATION_MIN loops reps INTO THAT SAME dir
  // until stopped — not a fresh dir per batch. `--steps N` truncates the history to its
  // first N ops (a prefix, for shrinking a finding); the final settle still reconnects
  // any node left partitioned by the cut.
  // Already normalized above (parsedHistory) so the printed/dir string is exactly what executes
  // (same as generated histories); `--steps` truncates the canonical form to its first N ops.
  let hist = parsedHistory!;
  if (steps > 0) hist = hist.slice(0, steps);
  const str = serialize(hist);
  const groupName = `${tsStamp()}-${str}`;
  const strDir = path.join(runsRoot, groupName);
  activeGroup = { strDir, groupName };
  const soaking = histories <= 0 || durationMin > 0;
  console.log(`\n=== history ${str}  ${soaking ? "(soaking — stop to end)" : `(×${repeat})`} ===`);
  for (let r = 0; soaking ? keepGoing(r) : r < repeat; r++) await runRep(hist, str, strDir);
  tagHistoryDir(strDir, groupName);
} else {
  for (let h = 0; keepGoing(h); h++) {
    const history = scenario === "stale" ? staleReconnect(genParams) : generateHistory(genParams);
    await runHistoryReps(history);
  }
}

console.log(tally());
process.exit(nonOk() === 0 ? 0 : 1);
