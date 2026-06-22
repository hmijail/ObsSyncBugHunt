// Offline analyzer for soak runs. Reads every runs/<ts>/results.json (+ meta.json)
// and prints an aggregate report: pass/fail, CONFIRMED data losses (a lost token
// recoverable from server history but absent from the vault), conflict counts,
// and the sync-duration distribution — grouped by scenario/flags. Pure file
// reader: run anytime, nodes up or not.
//
//   npm run analyze            (reads ./runs)
//   npm run analyze -- <dir>

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

interface Forensic { note: string; token: string; serverRecoverable: boolean; serverVersions: number[] }
interface NoteVerdict { lost: string[]; onlyInConflict: string[]; duplicated: unknown[]; converged: boolean; conflictFiles: number }
interface Results {
  verdict: { ok: boolean; notes: NoteVerdict[] };
  timings: { totalSec: number; convergenceSec: number; syncTimedOut: boolean };
  forensics?: Forensic[];
}
interface Meta { scenario?: string; isolator?: string; concurrent?: boolean; isolateProb?: number; prepend?: boolean; ops?: string }

const base = process.argv[2] ?? "runs";
if (!existsSync(base)) {
  console.error(`no runs dir at ${base}`);
  process.exit(1);
}

interface Group {
  runs: number; pass: number; fail: number;
  confirmedLost: number; unconfirmedLost: number;
  conflictRuns: number; timeouts: number;
  conv: number[];
  failingDirs: string[];
}
const newGroup = (): Group => ({ runs: 0, pass: 0, fail: 0, confirmedLost: 0, unconfirmedLost: 0, conflictRuns: 0, timeouts: 0, conv: [], failingDirs: [] });
const groups = new Map<string, Group>();
const overall = newGroup();
let skipped = 0;

function stats(xs: number[]) {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return `min=${s[0]} med=${s[Math.floor(s.length / 2)]} max=${s[s.length - 1]} avg=${Math.round(sum / s.length)}`;
}

function tally(g: Group, r: Results, dir: string) {
  g.runs++;
  g.conv.push(r.timings?.convergenceSec ?? 0);
  if (r.timings?.syncTimedOut) g.timeouts++;
  const conflict = r.verdict.notes.some((n) => n.conflictFiles > 0 || n.onlyInConflict.length > 0);
  if (conflict) g.conflictRuns++;
  for (const f of r.forensics ?? []) (f.serverRecoverable ? g.confirmedLost++ : g.unconfirmedLost++);
  if (r.verdict.ok) g.pass++;
  else { g.fail++; if (g.failingDirs.length < 50) g.failingDirs.push(dir); }
}

for (const name of readdirSync(base)) {
  const dir = path.join(base, name);
  if (!statSync(dir).isDirectory()) continue;
  const rf = path.join(dir, "results.json");
  const mf = path.join(dir, "meta.json");
  // Require both: meta.json marks the current run-driver format (old runs lack it
  // and lack forensics, so counting them would pollute the report).
  if (!existsSync(rf) || !existsSync(mf)) { skipped++; continue; }
  let r: Results;
  let meta: Meta;
  try {
    r = JSON.parse(readFileSync(rf, "utf8"));
    meta = JSON.parse(readFileSync(mf, "utf8"));
  } catch { skipped++; continue; }
  const key = `${meta.scenario ?? "?"} | conc=${meta.concurrent ?? "?"} iso=${meta.isolateProb ?? "?"} ${meta.isolator ?? "?"} prep=${meta.prepend ?? "?"} ops=${meta.ops ?? "?"}`;
  if (!groups.has(key)) groups.set(key, newGroup());
  tally(groups.get(key)!, r, dir);
  tally(overall, r, dir);
}

console.log(`Analyzed ${overall.runs} runs from ${base}/ (${skipped} skipped/incomplete)\n`);
for (const [key, g] of [...groups.entries()].sort()) {
  console.log(`### ${key}`);
  console.log(`  runs=${g.runs} pass=${g.pass} fail=${g.fail}  CONFIRMED-LOST=${g.confirmedLost} (unconfirmed=${g.unconfirmedLost})  conflictRuns=${g.conflictRuns}  syncTimeouts=${g.timeouts}`);
  console.log(`  convergenceSec: ${stats(g.conv)}`);
}
console.log(`\n=== OVERALL ===`);
console.log(`runs=${overall.runs} pass=${overall.pass} fail=${overall.fail}  CONFIRMED-LOST=${overall.confirmedLost} (unconfirmed=${overall.unconfirmedLost})  conflictRuns=${overall.conflictRuns}  syncTimeouts=${overall.timeouts}`);
console.log(`convergenceSec: ${stats(overall.conv)}`);
if (overall.failingDirs.length) console.log(`\nfailing runs (up to 50):\n` + overall.failingDirs.map((d) => "  " + d).join("\n"));
