// Two distributions, read out of the rep logs: how long a change takes to leave the node that made
// it (UPLOAD), and how long it takes to reach another node (DOWNLOAD).
//
// THEY ARE NEVER SUMMED OR POOLED. They are measured by different means and mean different things,
// and a single "sync latency" number would hide the only interesting thing about them.
//
// Upload is retroactive: a writing node's `sync:status` genuinely withholds "synced" until its push
// lands, so the existing `settle-poll` stream already dates it and no instrumentation was needed.
// Download is not, because a RECEIVING node's `sync:status` is blind to an inbound change — it
// reports "synced" a median of 0s into a wait — so nothing in the log implied it until
// `token-arrived` was added (see src/arrivals.ts).
//
// EDITS RIDE A ~10s CYCLE; CREATES DO NOT. Measured directly by src/probe-propagation.ts: creating
// a note reaches the peer in ~0.5s, while an edit waits for the next tick of a roughly 10-second
// cycle. So an edit's delivery time is set by WHERE IN THE CYCLE it fell — anywhere from ~0.5s to
// ~10s, roughly uniform. That is why the numbers here spread rather than cluster, and why a single
// "typical" figure would be meaningless.
//
// Against that, the harness looks about once a second and only once every node reports `synced`, so
// deliveries that happened to land early are already there at the first look. Those come back
// left-censored, and the censoring is a result, not a gap: it says the edit caught an early tick.
// The ones that RESOLVE into an interval are the ones that missed a tick and waited — the upper
// half of the cycle. Both halves are real; neither alone is the distribution.
//
// A WARNING FROM HOW THIS WENT, THREE TIMES. "Edits take ~10s" was reported by (1) a throwaway
// probe that always re-edited immediately after the previous edit landed — i.e. always at the same
// phase, so it measured one full PERIOD every time; (2) an offline reconstruction from
// `pause-snapshot`, whose samples are ~10s apart, which returned its own grid; and (3) briefly, a
// retraction in the other direction after in-rep arrivals showed sub-second numbers, which were
// simply edits that caught an early tick. Three methods, one lesson: a measurement whose cadence or
// resolution matches the period of the thing being measured will report the instrument back at you,
// and it will look tight and convincing while doing it. The `--jitter`-by-default design of
// probe-propagation.ts exists because of this.

export interface Upload {
  sec: number;
  /** The node already read "synced" the first time we looked: the push finished somewhere in
   *  [0, first poll] and we cannot say where. Counted, never mixed into the distribution. */
  censored: boolean;
}

export interface Download {
  /** Last look that MISSED the token, seconds since the append. `null` => left-censored: it was
   *  already there the FIRST time we looked, so delivery beat our fastest observation. That is an
   *  upper bound (arrival <= latestArrival), never a point estimate — and never a zero. */
  earliestArrival: number | null;
  /** First look that FOUND it, seconds since the append — the arrival happened at or before this. */
  latestArrival: number;
  created: boolean;
  from: string;
  to: string;
}

type Event = Record<string, unknown>;

const num = (e: Event, k: string): number | null => (typeof e[k] === "number" ? (e[k] as number) : null);

/** Split a rep's `settle-poll` stream back into the individual settles that produced it. Each
 *  `waitForSynced` call restarts `elapsedSec` at 0, so a non-increasing value marks a new one. */
function settleRuns(events: Event[]): Event[][] {
  const runs: Event[][] = [];
  let cur: Event[] = [];
  let prev: number | null = null;
  for (const e of events) {
    if (e.kind !== "settle-poll") continue;
    const el = num(e, "elapsedSec") ?? 0;
    if (prev === null || el < prev) {
      if (cur.length > 0) runs.push(cur);
      cur = [];
    }
    prev = el;
    cur.push(e);
  }
  if (cur.length > 0) runs.push(cur);
  return runs;
}

/**
 * Both distributions for ONE rep.
 *
 * A rep that partitioned anything is skipped entirely. An offline window is a partition, not
 * latency: including it would fold the ~60s disconnect threshold into a histogram that is supposed
 * to be about the server, and a reconnecting node reads "not synced" for reasons that have nothing
 * to do with an upload.
 */
export function repLatencies(events: Event[]): { uploads: Upload[]; downloads: Download[] } {
  if (events.some((e) => e.kind === "disconnecting" || e.kind === "connecting")) {
    return { uploads: [], downloads: [] };
  }
  // --- upload: how long the WRITER's own sync:status stayed unsynced after its append -----------
  // Only a wait on the node that just wrote measures this. A wait on any other node that reads
  // "not synced" is describing a pull it happens to know about, which is a different quantity.
  const uploads: Upload[] = [];
  let lastAuthor: string | null = null;
  const authorAt = new Map<Event, string | null>();
  for (const e of events) {
    if (e.kind === "appended") lastAuthor = String(e.node);
    if (e.kind === "settle-poll") authorAt.set(e, lastAuthor);
  }
  for (const run of settleRuns(events)) {
    const waitNode = run[0].wait;
    if (typeof waitNode !== "string") continue; // the final settle waits on everyone — not a writer
    if (waitNode !== authorAt.get(run[0])) continue; // receiver-side wait
    const firstSynced = run.find((p) => p.everySynced === true);
    if (!firstSynced) continue; // never got there (host outage etc.) — no measurement
    uploads.push({ sec: num(firstSynced, "elapsedSec") ?? 0, censored: firstSynced === run[0] });
  }

  // --- download: read straight off the event the tracker logs ----------------------------------
  const downloads: Download[] = [];
  for (const e of events) {
    if (e.kind !== "token-arrived") continue;
    const latestArrival = num(e, "latestArrivalSec");
    if (latestArrival === null) continue;
    downloads.push({
      earliestArrival: num(e, "earliestArrivalSec"),
      latestArrival,
      created: e.created === true,
      from: String(e.from),
      to: String(e.to),
    });
  }
  return { uploads, downloads };
}

// --- rendering ---------------------------------------------------------------------------------

const pct = (xs: number[], p: number): number => (xs.length === 0 ? 0 : xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]);
const med = (xs: number[]): number => pct(xs, 0.5);

/** Coarse `#` bars. `width` is the bucket size in seconds; everything at or past `cap` piles into
 *  one final bucket so a single stall cannot stretch the axis into uselessness. */
function histogram(xs: number[], width: number, cap: number): string[] {
  if (xs.length === 0) return ["  (no measurements)"];
  const buckets = new Map<number, number>();
  for (const x of xs) {
    const b = Math.min(Math.floor(x / width) * width, cap);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const top = Math.max(...buckets.values());
  const out: string[] = [];
  for (let b = 0; b <= cap; b += width) {
    const n = buckets.get(b) ?? 0;
    const label = b === cap ? `${b}s+` : `${b}-${b + width}s`;
    out.push(`  ${label.padStart(9)}  ${"#".repeat(Math.round((40 * n) / top)).padEnd(40)} ${n}`);
  }
  return out;
}

const line = (label: string, xs: number[]): string =>
  xs.length === 0 ? `  ${label}: none` : `  ${label}: n=${xs.length}  min=${xs[0].toFixed(1)}s  med=${med(xs).toFixed(1)}s  p90=${pct(xs, 0.9).toFixed(1)}s  max=${xs[xs.length - 1].toFixed(1)}s`;

/**
 * One `#` section for analysis.md. Both halves report their own censoring and their own precision
 * next to the result: a reader who cannot see how coarse the measurement is will read the buckets
 * as if they were exact.
 */
export function renderLatency(uploads: Upload[], downloads: Download[]): string {
  const out: string[] = ["# Sync latency", ""];

  // ---- upload ----
  const up = uploads.filter((u) => !u.censored).map((u) => u.sec).sort((a, b) => a - b);
  const upCensored = uploads.filter((u) => u.censored).length;
  out.push("## Upload — append until the writing node's own `sync:status` reads `synced`");
  out.push("");
  out.push("Read from the existing `settle-poll` stream; no instrumentation. Only waits on the node");
  out.push("that just wrote count — a wait elsewhere that reads `not synced` is describing a pull.");
  out.push("");
  out.push(line("uploads", up));
  out.push(`  left-censored: ${upCensored} more were already \`synced\` on the first poll — the push finished in under ~1s but we cannot say where. Excluded, not counted as zero.`);
  out.push("");
  out.push(...histogram(up, 1, 10));
  out.push("");

  // ---- download ----
  // Two populations, and they answer different questions. RESOLVED arrivals were still missing at
  // some look and present at a later one, so they are bracketed — and because our first look lands
  // under ~1s, being resolved at all means this delivery was slower than that. They are the tail.
  // CENSORED arrivals were already there the first time anyone looked: not a failure to measure but
  // a finding, "delivered in under `latestArrival` seconds", which is the bulk of normal operation.
  const resolved = downloads.filter((d) => d.earliestArrival !== null).sort((a, b) => a.latestArrival - b.latestArrival);
  const censored = downloads.filter((d) => d.earliestArrival === null).sort((a, b) => a.latestArrival - b.latestArrival);
  const latestOfResolved = resolved.map((d) => d.latestArrival);
  const widths = resolved.map((d) => d.latestArrival - (d.earliestArrival as number)).sort((a, b) => a - b);
  const firstLooks = censored.map((d) => d.latestArrival);
  out.push("## Download — append on one node until the token is visible on another");
  out.push("");
  out.push("From `token-arrived` (src/arrivals.ts). Every measurement is an INTERVAL — we see only");
  out.push("what we poll — so nothing here is a point estimate.");
  out.push("");
  out.push(`  delivered before our first look: ${censored.length} of ${downloads.length}`);
  out.push(line("    their first look landed at", firstLooks));
  out.push("    i.e. these arrivals completed in under that, and Sync beat the harness's fastest");
  out.push("    observation. A bound, not a gap in the data.");
  out.push("");
  out.push(`  resolved (missing at one look, present at a later one): ${resolved.length}`);
  // The LOWER bound is the firm claim — "this delivery was still missing at N seconds" is a fact
  // about Sync, whereas the upper bound is partly a fact about when we next got round to looking.
  out.push(line("    lower bound (still missing at)", resolved.map((d) => d.earliestArrival as number).sort((a, b) => a - b)));
  out.push(line("    upper bound (seen by)", latestOfResolved));
  out.push(line("    interval width", widths));
  out.push("    These are, by construction, the deliveries slower than a first look — the tail, and");
  out.push("    the only part of the distribution this harness can actually resolve.");
  out.push("");
  out.push(...histogram(latestOfResolved, 2, 20));
  out.push("");

  // splits — free, and either could be the finding. Over the resolved set only: pooling in the
  // censored ones would compare "how slow was it" against "how fast did we look", which is not a
  // property of Sync at all.
  const split = (name: string, sel: (d: Download) => boolean): void => {
    out.push(line(name, resolved.filter(sel).map((d) => d.latestArrival)));
  };
  split("  created (a new note)", (d) => d.created);
  split("  edited (an existing note)", (d) => !d.created);
  for (const dir of [...new Set(resolved.map((d) => `${d.from} -> ${d.to}`))].sort()) {
    split(`  ${dir}`, (d) => `${d.from} -> ${d.to}` === dir);
  }
  out.push("");

  // ---- calibration: how patient must a `W<n>` be? ----
  //
  // This used to calibrate `W`'s quiescence window. There is no such window any more: `W` waits for
  // the tokens themselves, so nothing needs calibrating for it to be correct. What DOES still need a
  // number is `W<n>` — the deliberately impatient wait — because n decides how often a history hands
  // off with data still in flight, which is the condition the whole experiment is built to create.
  if (downloads.length > 0) {
    out.push("## How patient must a `W<n>` be?");
    out.push("");
    out.push("`W` itself needs no window — it waits for the tokens. `W<n>` gives up after n seconds,");
    out.push("and this is the share of deliveries that would already have landed by then.");
    out.push("");
    out.push("A censored arrival whose first look fell inside n is KNOWN to have landed inside it, so the");
    out.push("bound decides it. One whose first look fell outside decides nothing and is excluded from the");
    out.push("denominator rather than guessed at in either direction.");
    out.push("");
    for (const n of [1, 2, 5, 10, 30, 60]) {
      const known = downloads.filter((d) => d.earliestArrival !== null || d.latestArrival <= n);
      const inside = known.filter((d) => d.latestArrival <= n).length;
      const pct = known.length === 0 ? "  -" : `${((100 * inside) / known.length).toFixed(0).padStart(3)}%`;
      out.push(`  W${String(n).padEnd(3)} covers ${String(inside).padStart(4)}/${String(known.length).padEnd(4)} decidable deliveries  ${pct}` +
        `   (${downloads.length - known.length} undecidable: first look came later)`);
    }
    out.push("");
    if (latestOfResolved.length > 0) {
      out.push(`The slowest RESOLVED delivery was ${latestOfResolved[latestOfResolved.length - 1].toFixed(1)}s, so a patience covering every one seen would need`);
      out.push("that much. Upper bounds throughout, so these shares are conservative — true arrivals are at or");
      out.push("before the figures quoted, meaning a given n covers at least this share, not at most.");
      out.push("");
    }
  }
  return out.join("\n");
}
