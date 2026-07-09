// Offline analyzer for soak runs. Layout is runs/<history-string>/<rep>/, where a
// failing rep dir carries a `-LOST`/`-UNKNOWN` suffix. Aggregates per history string:
// reps, losses (split server-dropped vs never-registered — the latter is worse),
// the caught inconsistency outcomes (`-OBSFAIL`/`-UNKNOWN`, read from the dir suffix
// since they have no verdict), the sync-duration distribution, and — written to
// <dir>/analysis.md — a markdown table of each rep's whole "global state" (see
// buildStateCells), grouped first by outcome (PASS/LOST/DUPL/...). Groups are per history
// string only, NEVER merged across different histories — note letters/tokens from
// unrelated DSL structures aren't comparable. A history that's all-PASS and landed in the
// exact same state every rep is "uninteresting" — nothing to dig into — so it's pulled out
// of the per-history sections entirely and listed, one row per history with its own
// convergence-time stats, in a trailing `# Uninteresting` table instead. History sections
// render at `#`; their category tables at `##`. Both the interesting sections and the
// uninteresting table are ordered newest-first (history dirnames are `DDTHHMMSS-<dsl>`
// prefixed, so plain descending string comparison is chronological). Every timing stat uses
// the MEDIAN, not the average — a single rare-but-huge transient outlier (e.g. one 8-hour
// stall) would drag an average up and hide what's actually typical. Pure file reader — run
// anytime.
//
//   npm run analyze            (reads ./runs, writes ./runs/analysis.md)
//   npm run analyze -- <dir>

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Forensic { serverRecoverable: boolean }
export interface NoteVerdict {
  note: string; lost: string[]; onlyInConflict: string[]; converged: boolean; conflictFiles: number;
  duplicated: { token: string; maxCount: number }[];
  conflictMeta?: { file: string; device: string | null; wellFormed: boolean; holders: string[] }[];
}
export interface Observation { node: string; note: string; canonical: string | null; conflicts: { file: string; content: string }[] }
export interface Results {
  verdict: { ok: boolean; notes: NoteVerdict[] };
  timings: { convergenceSec: number; syncTimedOut: boolean; unsynced?: boolean };
  forensics?: Forensic[];
  observations?: Observation[]; // absent in results.json written before this field existed
  noteLetters?: Record<string, string>; // concrete note name -> logical DSL letter; ditto
}

// --- outcome classification (mirrors run.ts's ranked FAIL_SUFFIXES ladder, dash dropped
// for a readable table header) ------------------------------------------------
export function classify(r: Results): string {
  if (r.timings?.unsynced) return "NOUPLOAD";
  if (r.timings?.syncTimedOut) return "TIMEOUT";
  if (r.verdict.notes.some((n) => n.lost.length > 0)) return "LOST";
  if (r.verdict.notes.some((n) => n.duplicated.length > 0)) return "DUPL";
  if (r.verdict.notes.some((n) => !n.converged)) return "SYNCBAD";
  return "PASS";
}
const CATEGORY_ORDER = ["NOUPLOAD", "TIMEOUT", "LOST", "DUPL", "SYNCBAD", "PASS"];

// --- whole-rep global state: every touched note (+ its conflict files), as table cells ---
// A rep's state spans every node/note together — "converged" is inherently a cross-node
// judgment, so there's no meaningful unit narrower than the whole rep. Format-agnostic token
// extraction (`/\([^)]*\)/g` — matches any parenthesized run) works across both the old
// `(op-...)` and current `(<node>-<seq>-<note>)` token shapes.
const TOKEN_RE = /\([^)]*\)/g;
export function tokensIn(text: string): string[] {
  return [...new Set(text.match(TOKEN_RE) ?? [])].sort();
}

// Best-effort letter recovery for results.json predating `noteLetters`: the note-naming
// convention (`<NOTE_DIR>/<repId>-<letter>-<historyString>`) has been stable throughout, and a
// serialized DSL history string never contains a dash — so the letter is reliably the
// second-to-last dash-separated segment (robust even to a collision-suffixed rep id, e.g.
// `...-2-a-...`, since the regex anchors on the end of the string). `noteLetters` (the
// authoritative, explicit source) is always tried first; this is purely a recovery path for
// historical data, not the primary mechanism.
const FULLNAME_LETTER_RE = /-([a-z])-[^-/]+$/;
export function letterOf(fullname: string, noteLetters: Record<string, string> | undefined): string {
  return noteLetters?.[fullname] ?? FULLNAME_LETTER_RE.exec(fullname)?.[1] ?? fullname;
}

/** column label -> content. A note's own column holds its canonical tokens, or "DIVERGED" if
 *  nodes disagree (no per-node breakdown here — that detail is in the rep's own
 *  results.json/history.jsonl). Each converged note's conflict files get their own
 *  `<letter>-Conf-<device>` column, disambiguated with a trailing index if the same device
 *  produced more than one for that note. */
export function buildStateCells(r: Results): Record<string, string> | null {
  if (!r.observations) return null; // older results.json — can't reconstruct
  const fullnames = [...new Set(r.verdict.notes.map((n) => n.note))];
  const cells: Record<string, string> = {};
  for (const fullname of fullnames) {
    const letter = letterOf(fullname, r.noteLetters);
    const nv = r.verdict.notes.find((n) => n.note === fullname)!;
    if (!nv.converged) { cells[letter] = "DIVERGED"; continue; }
    const obs = r.observations.find((o) => o.note === fullname);
    cells[letter] = tokensIn(obs?.canonical ?? "").join(" ");
    const deviceSeen = new Map<string, number>();
    for (const cm of nv.conflictMeta ?? []) {
      const device = cm.device ?? "?";
      const n = (deviceSeen.get(device) ?? 0) + 1;
      deviceSeen.set(device, n);
      const col = n > 1 ? `${letter}-Conf-${device}-${n}` : `${letter}-Conf-${device}`;
      cells[col] = tokensIn(obs?.conflicts.find((c) => c.file === cm.file)?.content ?? "").join(" ");
    }
  }
  return cells;
}
// Sorted-key JSON is the dedup key: "a" sorts right before "a-Conf-n1" (prefix), then "b" —
// already the right column order for rendering, no separate ordering logic needed.
export function stateKey(cells: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(cells).sort()) sorted[k] = cells[k];
  return JSON.stringify(sorted);
}

export interface StateEntry { cells: Record<string, string>; count: number; reps: string[] }
interface Group {
  reps: number; pass: number; fail: number;
  lost: number; serverDropped: number; neverRegistered: number;
  duplReps: number; diffReps: number; unsyncedReps: number;
  timeouts: number; conv: number[];
  // Caught inconsistency outcomes (no results.json — counted from the rep dir suffix).
  obsfail: number; unknown: number;
  categories: Map<string, Map<string, StateEntry>>; // classify() -> stateKey() -> entry
}
const newGroup = (): Group => ({
  reps: 0, pass: 0, fail: 0, lost: 0, serverDropped: 0, neverRegistered: 0, duplReps: 0, diffReps: 0,
  unsyncedReps: 0, timeouts: 0, conv: [], obsfail: 0, unknown: 0, categories: new Map(),
});

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// median, not avg — a single rare-but-huge transient outlier (e.g. one 8-hour stall) would drag
// an average up and hide what's actually typical.
interface Stats { min: number; median: number; max: number; span: number }
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function computeStats(xs: number[]): Stats | null {
  if (!xs.length) return null;
  const min = Math.min(...xs), max = Math.max(...xs);
  return { min, median: median(xs), max, span: max - min };
}
const stats = (xs: number[]): string => {
  const s = computeStats(xs);
  return s ? `min=${s.min} median=${s.median} max=${s.max} span=${s.span}` : "n/a";
};

function tally(g: Group, r: Results, rep: string) {
  g.reps++;
  g.conv.push(r.timings?.convergenceSec ?? 0);
  if (r.timings?.syncTimedOut) g.timeouts++;
  if (r.timings?.unsynced) g.unsyncedReps++;
  const lost = r.verdict.notes.reduce((s, n) => s + n.lost.length, 0);
  g.lost += lost;
  for (const f of r.forensics ?? []) (f.serverRecoverable ? g.serverDropped++ : g.neverRegistered++);

  const cells = buildStateCells(r);
  if (cells) {
    const category = classify(r);
    const key = stateKey(cells);
    const byState = g.categories.get(category) ?? new Map<string, StateEntry>();
    const entry = byState.get(key) ?? { cells, count: 0, reps: [] };
    entry.count++;
    entry.reps.push(rep);
    byState.set(key, entry);
    g.categories.set(category, byState);
  }

  // Numeric aggregates mirror run.ts's suffix ladder so a rep counted as DUPL/DIFF here
  // matches its on-disk `-DUPL`/`-SYNCBAD` dir.
  if (r.verdict.ok && !r.timings?.unsynced && !r.timings?.syncTimedOut) { g.pass++; return; }
  g.fail++;
  if (r.timings?.unsynced || r.timings?.syncTimedOut || lost > 0) return; // already counted above
  if (r.verdict.notes.some((n) => n.duplicated.length > 0)) g.duplReps++;
  else if (r.verdict.notes.some((n) => !n.converged)) g.diffReps++;
}

// A caught inconsistency rep has no verdict (runHistory threw): it writes meta.json +
// <category>.json but no results.json, and its dir carries the -OBSFAIL / -UNKNOWN suffix.
// Count it first-class from the suffix so it shows up in every tally, not as "skipped" — but
// there's no verdict/content to put in a states table, so it never reaches `categories`.
function tallyThrown(g: Group, kind: "obsfail" | "unknown") {
  g.reps++;
  g[kind]++;
}

// Only non-zero fields, lowercase, compact when there's nothing to flag.
export const line = (g: Group) => {
  const parts = [`reps=${g.reps}`, `pass=${g.pass}`];
  if (g.fail) parts.push(`fail=${g.fail}`);
  if (g.obsfail) parts.push(`obsfail=${g.obsfail}`);
  if (g.unknown) parts.push(`unknown=${g.unknown}`);
  if (g.lost) parts.push(`lost=${g.lost}(dropped=${g.serverDropped},unreg=${g.neverRegistered})`);
  if (g.duplReps) parts.push(`dupl=${g.duplReps}`);
  if (g.diffReps) parts.push(`diff=${g.diffReps}`);
  if (g.unsyncedReps) parts.push(`unsynced=${g.unsyncedReps}`);
  if (g.timeouts) parts.push(`timeouts=${g.timeouts}`);
  return parts.join(" ") + `\nconvergenceSec: ${stats(g.conv)}`;
};

/** One markdown table per (history, category). Columns = the union of every entry's cell
 *  keys WITHIN that category (already sorted correctly — a note letter sorts right before its
 *  own conflict columns, see stateKey); rows sorted by descending count; the `reps` column
 *  (which reps produced this exact shape) is included on every category EXCEPT PASS — PASS
 *  reps aren't what you dig into. */
export function renderCategoryTable(category: string, byState: Map<string, StateEntry>): string {
  const entries = [...byState.values()].sort((a, b) => b.count - a.count);
  const columns = [...new Set(entries.flatMap((e) => Object.keys(e.cells)))].sort();
  const showReps = category !== "PASS";
  const headers = ["count", ...columns, ...(showReps ? ["reps"] : [])];
  const rows = entries.map((e) => {
    const cells = [String(e.count), ...columns.map((c) => e.cells[c] ?? "")];
    if (showReps) cells.push(e.reps.join(", "));
    return `| ${cells.join(" | ")} |`;
  });
  const headerRow = `| ${headers.join(" | ")} |`;
  const sepRow = `|${headers.map(() => "---").join("|")}|`;
  return [`## ${category}`, "", headerRow, sepRow, ...rows, ""].join("\n");
}

export function renderGroup(str: string, g: Group): string {
  const sections = [`# ${str}`, line(g), ""];
  for (const category of CATEGORY_ORDER) {
    const byState = g.categories.get(category);
    if (byState && byState.size > 0) sections.push(renderCategoryTable(category, byState));
  }
  return sections.join("\n");
}

/** One row per uninteresting history, its own convergence-time stats as columns rather than one
 *  history's own (now-absent) section — the whole point of pulling these out is a quick scan, not
 *  having to open each one individually. */
export function renderUninteresting(rows: [string, Group][]): string {
  const header = "| history | min | median | max | span |";
  const sep = "|---|---|---|---|---|";
  const body = rows.map(([str, g]) => {
    const s = computeStats(g.conv);
    return s
      ? `| ${str} | ${s.min} | ${s.median} | ${s.max} | ${s.span} |`
      : `| ${str} | n/a | n/a | n/a | n/a |`;
  });
  return ["# Uninteresting", "", header, sep, ...body, ""].join("\n");
}

// A history is "uninteresting" when every rep passed AND every one of them landed in the exact
// same state (nothing to compare, nothing to dig into) — a full per-history breakdown for that
// is just noise. `byState` missing/empty counts too (older results.json with no `observations`
// data at all — equally nothing to show variety in).
export function isUninteresting(g: Group): boolean {
  if (g.fail || g.obsfail || g.unknown) return false;
  const byState = g.categories.get("PASS");
  return !byState || byState.size <= 1;
}

/** Walk `base` (runs/<history>/<rep>/), tally every rep, and write `<base>/analysis.md`. The
 *  only I/O in this module — everything above is pure and unit-tested directly. */
export function main(base: string): void {
  if (!existsSync(base)) {
    console.error(`no runs dir at ${base}`);
    process.exit(1);
  }
  const groups = new Map<string, Group>();
  let skipped = 0;

  // Sorted so processing order (and any downstream tie-break) is deterministic regardless of
  // filesystem/readdir ordering, not just cosmetic.
  for (const str of readdirSync(base).sort()) {
    const strDir = path.join(base, str);
    if (!isDir(strDir)) continue;
    if (!groups.has(str)) groups.set(str, newGroup());
    const g = groups.get(str)!;
    for (const repFile of readdirSync(strDir)) {
      if (!repFile.endsWith(".jsonl")) continue;
      const rep = repFile.slice(0, -".jsonl".length);
      // A rep's file always ENDS with exactly one results/obsfail/unknown event (the success
      // path's last logger.log call, or the inconsistency path's — nothing is ever logged after it), so
      // the last line alone carries the verdict; no need to scan the whole file.
      const lines = readFileSync(path.join(strDir, repFile), "utf8").split("\n").filter(Boolean);
      let last: Record<string, unknown>;
      try { last = JSON.parse(lines[lines.length - 1]); } catch { skipped++; continue; }
      if (last.kind === "results") { tally(g, last as unknown as Results, rep); continue; }
      if (last.kind === "obsfail") { tallyThrown(g, "obsfail"); continue; }
      if (last.kind === "unknown") { tallyThrown(g, "unknown"); continue; }
      skipped++; // genuinely incomplete — crashed before any verdict was ever logged
    }
  }

  // Newest-first, everywhere: history dirnames are DDTHHMMSS-<dsl> prefixed, so descending
  // string comparison is chronological. NOTE: no cross-history OVERALL aggregate — note
  // letters restart from `a` for every independently-generated history, so merging states (or
  // even convergence-time stats) across unrelated histories would be exactly the "collapsing
  // across different histories" mistake — this sort only reorders whole groups, never merges them.
  const active = [...groups.entries()].filter(([, g]) => g.reps > 0).sort(([a], [b]) => b.localeCompare(a));
  const interesting = active.filter(([, g]) => !isUninteresting(g));
  const uninteresting = active.filter(([, g]) => isUninteresting(g));

  const totalReps = [...groups.values()].reduce((s, g) => s + g.reps, 0);
  const sections = interesting.map(([str, g]) => renderGroup(str, g));
  if (uninteresting.length > 0) sections.push(renderUninteresting(uninteresting));
  const md = sections.join("\n");
  const outPath = path.join(base, "analysis.md");
  writeFileSync(outPath, md + "\n");

  console.log(`Analyzed ${totalReps} reps from ${base}/ (${skipped} skipped/incomplete)`);
  console.log(`Wrote analysis to ${outPath}`);
}

// Only run when invoked directly (`npx tsx src/analyze.ts`), not when imported for tests.
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "runs");
}
