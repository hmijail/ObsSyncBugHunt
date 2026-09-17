import test from "node:test";
import assert from "node:assert/strict";
import { ArrivalTracker } from "./arrivals.js";
import { repLatencies, renderLatency } from "./latency.js";
import type { RunLogger } from "./history.js";
import type { NodeObservation } from "./oracle.js";

const stubLogger = (events: Record<string, unknown>[]) =>
  ({ log: (e: Record<string, unknown>) => events.push(e) }) as unknown as RunLogger;

const NOTE = "bughunt/x-a-N1Aa";
const obs = (node: string, canonical: string | null, note = NOTE): NodeObservation =>
  ({ node, note, canonical, conflicts: [] });

test("ArrivalTracker: an arrival is bracketed by the look that missed it and the one that found it", () => {
  const events: Record<string, unknown>[] = [];
  const t = new ArrivalTracker();
  t.appended("(n1-1-a)", "n1", NOTE, false);
  t.observe([obs("n2", "")], stubLogger(events)); // missed
  t.observe([obs("n2", "(n1-1-a)")], stubLogger(events)); // found
  const arrived = events.filter((e) => e.kind === "token-arrived");
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].from, "n1");
  assert.equal(arrived[0].to, "n2");
  assert.equal(typeof arrived[0].earliestArrivalSec, "number"); // we DID see it absent — a real lower bound
  assert.ok((arrived[0].latestArrivalSec as number) >= (arrived[0].earliestArrivalSec as number));
});

test("ArrivalTracker: present on the very first look is LEFT-CENSORED, not a fast arrival", () => {
  const events: Record<string, unknown>[] = [];
  const t = new ArrivalTracker();
  t.appended("(n1-1-a)", "n1", NOTE, false);
  t.observe([obs("n2", "(n1-1-a)")], stubLogger(events));
  const a = events.find((e) => e.kind === "token-arrived")!;
  // null means "it beat our first look": an upper bound, never a point estimate and never a zero.
  // latency.ts keeps these as their own population rather than mixing them into the distribution.
  assert.equal(a.earliestArrivalSec, null);
  assert.equal(repLatencies([a]).downloads[0].earliestArrival, null);
});

test("ArrivalTracker: reports each (node, token) once, and never the author's own copy", () => {
  const events: Record<string, unknown>[] = [];
  const log = stubLogger(events);
  const t = new ArrivalTracker();
  t.appended("(n1-1-a)", "n1", NOTE, false);
  t.observe([obs("n1", "(n1-1-a)"), obs("n2", "")], log);
  t.observe([obs("n1", "(n1-1-a)"), obs("n2", "(n1-1-a)")], log);
  t.observe([obs("n1", "(n1-1-a)"), obs("n2", "(n1-1-a)")], log); // still there — not a new arrival
  const arrived = events.filter((e) => e.kind === "token-arrived");
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].to, "n2");
});

test("ArrivalTracker: an absent note counts as a look that missed it, and other notes are ignored", () => {
  const events: Record<string, unknown>[] = [];
  const log = stubLogger(events);
  const t = new ArrivalTracker();
  t.appended("(n1-1-a)", "n1", NOTE, false);
  t.observe([obs("n2", null)], log); // note not there at all — still a genuine "not yet"
  t.observe([obs("n2", "(n1-1-a)", "bughunt/x-b-N1Aa")], log); // a DIFFERENT note, same token text
  assert.equal(events.filter((e) => e.kind === "token-arrived").length, 0);
  t.observe([obs("n2", "(n1-1-a)")], log);
  assert.equal((events.find((e) => e.kind === "token-arrived")!.earliestArrivalSec as number) >= 0, true);
});

test("ArrivalTracker: a token that never lands is never reported", () => {
  const events: Record<string, unknown>[] = [];
  const t = new ArrivalTracker();
  t.appended("(n1-1-a)", "n1", NOTE, false);
  t.observe([obs("n2", "")], stubLogger(events));
  t.observe([obs("n2", "")], stubLogger(events));
  assert.equal(events.length, 0); // silence is the loss oracle's business, not this module's
});

test("repLatencies: a rep that partitioned anything yields nothing at all", () => {
  // An offline window is a partition, not latency — folding it in would put the ~60s disconnect
  // threshold into a histogram about the server.
  const events = [
    { kind: "appended", node: "n1" },
    { kind: "disconnecting", node: "n2" },
    { kind: "token-arrived", from: "n1", to: "n2", earliestArrivalSec: 1, latestArrivalSec: 9 },
    { kind: "settle-poll", elapsedSec: 0, wait: "n1", everySynced: false },
    { kind: "settle-poll", elapsedSec: 3, wait: "n1", everySynced: true },
  ];
  const { uploads, downloads } = repLatencies(events);
  assert.deepEqual(uploads, []);
  assert.deepEqual(downloads, []);
});

test("repLatencies: upload counts only a wait on the node that just wrote", () => {
  const events = [
    { kind: "appended", node: "n1" },
    // n1 waits on itself: a real upload measurement, and it was NOT synced on the first poll.
    { kind: "settle-poll", elapsedSec: 0, wait: "n1", everySynced: false },
    { kind: "settle-poll", elapsedSec: 3, wait: "n1", everySynced: true },
    // n2 waits: reads "not synced" about a PULL. Different quantity — must not be counted.
    { kind: "settle-poll", elapsedSec: 0, wait: "n2", everySynced: false },
    { kind: "settle-poll", elapsedSec: 2, wait: "n2", everySynced: true },
    // the final settle waits on everyone, so it identifies no writer at all
    { kind: "settle-poll", elapsedSec: 0, final: true, everySynced: true },
  ];
  assert.deepEqual(repLatencies(events).uploads, [{ sec: 3, censored: false }]);
});

test("repLatencies: a writer already synced on its first poll is censored, not a zero", () => {
  const events = [
    { kind: "appended", node: "n1" },
    { kind: "settle-poll", elapsedSec: 0, wait: "n1", everySynced: true },
    { kind: "settle-poll", elapsedSec: 4, wait: "n1", everySynced: true },
  ];
  assert.deepEqual(repLatencies(events).uploads, [{ sec: 0, censored: true }]);
});

test("renderLatency: censored and resolved arrivals are reported as separate populations", () => {
  const md = renderLatency(
    [{ sec: 0, censored: true }, { sec: 3, censored: false }],
    [
      { earliestArrival: null, latestArrival: 2, created: false, from: "n1", to: "n2" },
      { earliestArrival: 4, latestArrival: 9, created: false, from: "n1", to: "n2" },
    ],
  );
  assert.match(md, /uploads: n=1\b/); // the censored one is not in the distribution
  assert.match(md, /left-censored: 1 more/);
  assert.match(md, /delivered before our first look: 1 of 2/);
  assert.match(md, /resolved \(missing at one look, present at a later one\): 1/);
  // Patience calibration, for `W<n>`. At n=5 the censored one (first look at 2s) is known to have
  // landed inside and counts as covered; the resolved one landed at 9s, outside. At n=10 both are
  // in. Neither is ever guessed at — a delivery whose first look came after n decides nothing and
  // leaves the denominator.
  assert.match(md, /W5\s+covers\s+1\/2\s+decidable deliveries\s+50%/);
  assert.match(md, /W10\s+covers\s+2\/2\s+decidable deliveries\s+100%/);
  assert.match(md, /W1\s+covers\s+0\/1\s+decidable deliveries\s+0%/);
});


test("corpus: reps are ordered by absolute timestamp, not by their month-less filename", () => {
  // `DDTHHMMSS` names carry no month, so `31T...` (Aug 31) sorts after `02T...` (Sep 2). Every
  // claim the corpus report makes is ordering-dependent ("found early", "nothing new since"), so
  // ordering by name silently scrambles them across a month boundary — it did, until this test.
  const aug31 = { at: "2026-08-31T20:59:59.000Z", rep: "31T205959" };
  const sep02 = { at: "2026-09-02T11:27:47.000Z", rep: "02T112747" };
  const byName = [aug31, sep02].sort((a, b) => a.rep.localeCompare(b.rep));
  const byTime = [aug31, sep02].sort((a, b) => a.at.localeCompare(b.at));
  assert.equal(byName[0].rep, "02T112747"); // wrong: September first
  assert.equal(byTime[0].rep, "31T205959"); // right: August first
});
