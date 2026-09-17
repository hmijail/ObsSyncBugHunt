// Corpus-level questions about runs/ that `analyze` deliberately does not answer.
//
// `analyze` is organised per history string, because that is the unit where a state table means
// something — note letters restart at `a` for every generated history, so two histories' states are
// not comparable. This script asks the questions that only make sense ACROSS histories, and it
// exists as a separate tool for exactly that reason: it answers "what is this whole corpus telling
// us", not "what happened in this history".
//
// It reads runs/ and nothing else. It does NOT belong in check-assumptions: that script asks
// whether the apparatus still is what we think it is, needs live nodes, and stops the world when an
// answer is wrong. This one measures our own accumulated history, needs no nodes, and its answers
// change every time you soak — a "difference since last time" here is the expected outcome, not an
// alarm.
//
// Usage: npm run corpus [-- <dir>]      (default ./runs)

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, type Results } from "./analyze.js";

interface Rep {
  /** ISO timestamp of the rep's first logged event. THE sort key — NOT the filename. Rep and
   *  directory names are `DDTHHMMSS`, which carries no month, so `31T205959` (Aug 31) sorts after
   *  `02T112747` (Sep 2) and any ordering built on the name silently scrambles across a month
   *  boundary. Everything below is an ordering-dependent claim ("found early", "nothing new
   *  since"), so getting this from the log rather than the name is not a detail. */
  at: string;
  rep: string; history: string; outcome: string; results: Results; partitioned: boolean; senderW: boolean; receiverW: boolean;
}

/** `W` immediately after an append is a wait on the node that just WROTE (has my edit gone out?);
 *  `W` right after a node selector is a wait on the node about to write (has anything arrived for
 *  me?). `waitForSynced` scopes to the active node only, so these ask genuinely different
 *  questions of Sync — and only one of them is a question Sync can answer honestly. */
const SENDER_W = /A[a-z]W/;
const RECEIVER_W = /N\d+P?\d*W/;

function load(base: string): Rep[] {
  const reps: Rep[] = [];
  for (const dir of readdirSync(base).sort()) {
    const full = path.join(base, dir);
    if (!existsSync(full) || !statSync(full).isDirectory()) continue;
    const m = /^\d+T\d+-(.*)$/.exec(dir);
    if (!m) continue;
    const history = m[1].replace(/-(BAD\d+|ENVFAIL\d*|OBSFAIL\d*|UNKNOWN\d*)$/, "");
    for (const file of readdirSync(full).sort()) {
      if (!file.endsWith(".jsonl")) continue;
      const lines = readFileSync(path.join(full, file), "utf8").split("\n").filter(Boolean);
      let last: Record<string, unknown>;
      try { last = JSON.parse(lines[lines.length - 1]); } catch { continue; }
      if (last.kind !== "results") continue; // no verdict: nothing to classify
      const results = last as unknown as Results;
      // Every event carries an absolute `ts`; the first line is the `history` event. Fall back to
      // the (month-less) name only if the file somehow has none, which loses nothing we had.
      let at = file;
      try { at = String((JSON.parse(lines[0]) as { ts?: string }).ts ?? file); } catch { /* keep name */ }
      reps.push({
        at, rep: file.replace(/\.jsonl$/, ""), history, outcome: classify(results), results,
        partitioned: /[DC]/.test(history),
        senderW: SENDER_W.test(history), receiverW: RECEIVER_W.test(history),
      });
    }
  }
  return reps;
}

/**
 * Which hand-off shape loses data?
 *
 * Partition-free only: with a `D`/`C` in the history a loss is about the partition, which would
 * drown the far smaller effect being looked for here.
 */
function waitPlacement(reps: Rep[]): string[] {
  const pf = reps.filter((r) => !r.partitioned);
  const out = ["## Loss rate by where the `W` sits (partition-free reps only)", ""];
  out.push("  `...AaW`  wait on the node that just WROTE   — has my edit gone out?");
  out.push("  `...N2W`  wait on the node about to write     — has anything arrived for me?");
  out.push("");
  out.push("  `waitForSynced` scopes to the active node, so these ask different questions, and only");
  out.push("  the first has an honest answer: a receiver reports `synced` whether or not something");
  out.push("  is inbound.");
  out.push("");
  out.push("  | wait placement | reps | lost | rate |");
  out.push("  |---|---|---|---|");
  const row = (name: string, sel: (r: Rep) => boolean): void => {
    const sub = pf.filter(sel);
    const lost = sub.filter((r) => r.outcome === "LOST").length;
    if (sub.length === 0) return;
    out.push(`  | ${name} | ${sub.length} | ${lost} | ${((100 * lost) / sub.length).toFixed(1)}% |`);
  };
  row("`N2W` only", (r) => r.receiverW && !r.senderW);
  row("`AaW` only", (r) => r.senderW && !r.receiverW);
  row("both", (r) => r.senderW && r.receiverW);
  row("neither (no `W`)", (r) => !r.senderW && !r.receiverW);
  row("**all partition-free**", () => true);
  out.push("");
  out.push("  READ WITH THE SELECTION BIAS IN MIND. `runs/` is not a random sample: it holds soaks");
  out.push("  repeated because a history looked promising, re-runs from debugging, and hand-written");
  out.push("  `HISTORY=` strings, and nothing in the log marks which is which. A history re-run");
  out.push("  BECAUSE it was failing contributes many losing reps, so these rates are inflated by an");
  out.push("  unknown amount — and inflated is the dangerous direction: it makes an experiment look");
  out.push("  cheaper than it is. Treat them as an upper bound on the rate and a lower bound on how");
  out.push("  many reps an arm needs.");
  out.push("");
  const handoffs = pf.reduce((s, r) => s + Math.max(0, (r.history.match(/N\d+/g) ?? []).length - 1), 0);
  const lost = pf.filter((r) => r.outcome === "LOST").length;
  if (handoffs > 0) {
    out.push(`  ${handoffs} cross-node hand-offs in total -> ${((100 * lost) / handoffs).toFixed(2)}% of them lose a token.`);
    out.push(`  Size experiments against that: at ${((100 * lost) / handoffs).toFixed(2)}%, a 20-rep arm comes back clean whether or`);
    out.push("  not the effect it is testing is real.");
  }
  return out;
}

/**
 * WHAT IS DELIBERATELY NOT HERE: an "is the generator still finding new behaviour?" curve.
 *
 * It was written, and removed, because `runs/` cannot answer it. The AFL-style version of that
 * question needs a sample of what the GENERATOR produces. What is on disk instead is a record of
 * what someone chose to run: soaks repeated because a history looked promising, re-runs while
 * debugging, hand-written `HISTORY=` strings. An accumulation curve over that measures the
 * operator's attention, not the generator's reach — and "first seen at history N" is meaningless
 * when N is ordered by when someone decided to type it.
 *
 * Nor can it be salvaged by filtering: the `history` event records the string and the settle knobs,
 * but nothing marks whether the string was generated or supplied, so generated and hand-picked runs
 * are indistinguishable after the fact.
 *
 * Answering it properly needs a purpose-built run rather than an archive: fix the generator
 * parameters, generate N histories, run each ONCE, and count distinct outcomes as N grows. One
 * history per outcome, no repetition, no selection. `make generate-histories` already produces the
 * strings; what is missing is running them once each and tallying — which is a small experiment, not
 * a report over existing data. If that is ever built, note it also needs the marker above, so a
 * later reader can tell its runs apart from hand-driven ones.
 */

/** The cross-history sections, as markdown. `analyze` appends these to runs/analysis.md so they are
 *  seen without having to remember a second command; `npm run corpus` prints the same thing when you
 *  want only these in the terminal. */
export function renderCorpus(reps: Rep[]): string {
  if (reps.length === 0) return "";
  return [`# Corpus overview (${reps.length} reps with a verdict)`, "", ...waitPlacement(reps)].join("\n");
}

function main(base: string): void {
  const reps = load(base);
  if (reps.length === 0) { console.error(`no reps with a verdict under ${base}/`); process.exit(1); }
  console.log(renderCorpus(reps));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2] ?? "runs");
}
export { load, SENDER_W, RECEIVER_W };
export type { Rep };
