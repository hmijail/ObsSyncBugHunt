// Offline analyzer for soak runs. Layout is runs/<history-string>/<rep>/, where a
// failing rep dir carries a `-LOST`/`-FAIL` suffix. Aggregates per history string:
// reps, losses (split server-dropped vs never-registered — the latter is worse),
// conflicts, and the sync-duration distribution. Pure file reader — run anytime.
//
//   npm run analyze            (reads ./runs)
//   npm run analyze -- <dir>

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

interface Forensic { serverRecoverable: boolean }
interface NoteVerdict { lost: string[]; onlyInConflict: string[]; converged: boolean; conflictFiles: number; duplicated: { token: string; maxCount: number }[] }
interface Results {
  verdict: { ok: boolean; notes: NoteVerdict[] };
  timings: { convergenceSec: number; syncTimedOut: boolean; unsynced?: boolean };
  forensics?: Forensic[];
}

const base = process.argv[2] ?? "runs";
if (!existsSync(base)) {
  console.error(`no runs dir at ${base}`);
  process.exit(1);
}

interface Group {
  reps: number; pass: number; fail: number;
  lost: number; serverDropped: number; neverRegistered: number;
  duplReps: number; diffReps: number; unsyncedReps: number;
  conflictReps: number; timeouts: number; conv: number[];
}
const newGroup = (): Group => ({ reps: 0, pass: 0, fail: 0, lost: 0, serverDropped: 0, neverRegistered: 0, duplReps: 0, diffReps: 0, unsyncedReps: 0, conflictReps: 0, timeouts: 0, conv: [] });
const groups = new Map<string, Group>();
const overall = newGroup();
let skipped = 0;

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const stats = (xs: number[]) => {
  if (!xs.length) return "n/a";
  const s = [...xs].sort((a, b) => a - b);
  return `min=${s[0]} med=${s[Math.floor(s.length / 2)]} max=${s[s.length - 1]} avg=${Math.round(s.reduce((a, b) => a + b, 0) / s.length)}`;
};

function tally(g: Group, r: Results) {
  g.reps++;
  g.conv.push(r.timings?.convergenceSec ?? 0);
  if (r.timings?.syncTimedOut) g.timeouts++;
  if (r.timings?.unsynced) g.unsyncedReps++;
  if (r.verdict.notes.some((n) => n.conflictFiles > 0 || n.onlyInConflict.length > 0)) g.conflictReps++;
  const lost = r.verdict.notes.reduce((s, n) => s + n.lost.length, 0);
  g.lost += lost;
  for (const f of r.forensics ?? []) (f.serverRecoverable ? g.serverDropped++ : g.neverRegistered++);
  // Bucket the rep by its (ranked) outcome — mirrors run.ts's suffix ladder so a
  // rep counted as DUPL/DIFF here matches its on-disk `-DUPL`/`-DIFF` dir.
  if (r.verdict.ok && !r.timings?.unsynced && !r.timings?.syncTimedOut) { g.pass++; return; }
  g.fail++;
  if (r.timings?.unsynced || r.timings?.syncTimedOut || lost > 0) return; // already counted above
  if (r.verdict.notes.some((n) => n.duplicated.length > 0)) g.duplReps++;
  else if (r.verdict.notes.some((n) => !n.converged)) g.diffReps++;
}

for (const str of readdirSync(base)) {
  const strDir = path.join(base, str);
  if (!isDir(strDir)) continue;
  if (!groups.has(str)) groups.set(str, newGroup());
  for (const rep of readdirSync(strDir)) {
    const repDir = path.join(strDir, rep);
    const rf = path.join(repDir, "results.json");
    const mf = path.join(repDir, "meta.json");
    if (!isDir(repDir) || !existsSync(rf) || !existsSync(mf)) { skipped++; continue; }
    let r: Results;
    try { r = JSON.parse(readFileSync(rf, "utf8")); } catch { skipped++; continue; }
    tally(groups.get(str)!, r);
    tally(overall, r);
  }
}

// Only non-zero fields, lowercase, compact when there's nothing to flag.
const line = (g: Group) => {
  const parts = [`reps=${g.reps}`, `pass=${g.pass}`];
  if (g.fail) parts.push(`fail=${g.fail}`);
  if (g.lost) parts.push(`lost=${g.lost}(dropped=${g.serverDropped},unreg=${g.neverRegistered})`);
  if (g.duplReps) parts.push(`dupl=${g.duplReps}`);
  if (g.diffReps) parts.push(`diff=${g.diffReps}`);
  if (g.unsyncedReps) parts.push(`unsynced=${g.unsyncedReps}`);
  if (g.timeouts) parts.push(`timeouts=${g.timeouts}`);
  if (g.conflictReps) parts.push(`conflicts=${g.conflictReps}`);
  return parts.join(" ") + `\n  convergenceSec: ${stats(g.conv)}`;
};

console.log(`Analyzed ${overall.reps} reps from ${base}/ (${skipped} skipped/incomplete)\n`);
for (const [str, g] of [...groups.entries()].sort((a, b) => (b[1].fail - a[1].fail) || (b[1].lost - a[1].lost))) {
  if (g.reps === 0) continue;
  console.log(`### ${str}\n  ${line(g)}`);
}
console.log(`\n=== OVERALL ===\n${line(overall)}`);
