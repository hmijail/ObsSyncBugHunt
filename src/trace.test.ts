import test from "node:test";
import assert from "node:assert/strict";
import { parse, normalize } from "./dsl.js";
import { expectedTrace, actualTrace, traceMismatch, durationFloorSec, type Step } from "./trace.js";

const opts = { nodeName: (s: number | "local") => (s === "local" ? "LOCAL" : `n${s}`) };
const expect = (h: string): Step[] => expectedTrace(normalize(parse(h)), opts);
const floor = (h: string, o = {}): number => durationFloorSec(normalize(parse(h)), { ...opts, ...o });

test("expectedTrace: node selectors produce no step — they move a cursor, they don't act", () => {
  assert.deepEqual(expect("N1AaN2Aa"), [
    { op: "append", node: "n1", note: "a" },
    { op: "append", node: "n2", note: "a" },
    { op: "settle" },
  ]);
});

test("expectedTrace: the worked example, including the implicit trailing reconnect", () => {
  assert.deepEqual(expect("N1DN2P60AaWN1Aa"), [
    { op: "disconnect", node: "n1" },
    { op: "pause", seconds: 60 },
    { op: "append", node: "n2", note: "a" },
    { op: "wait", node: "n2" },
    { op: "append", node: "n1", note: "a" },
    { op: "connect", node: "n1" }, // n1 was never reconnected by the history itself
    { op: "settle" },
  ]);
});

test("expectedTrace: a W on an offline node is a wait-skip, not a wait", () => {
  // Mirrors execute.ts: waiting on a disconnected node can't make progress, so it NOPs.
  assert.deepEqual(expect("N1AaDW"), [
    { op: "append", node: "n1", note: "a" },
    { op: "disconnect", node: "n1" },
    { op: "wait-skip", node: "n1" },
    { op: "connect", node: "n1" },
    { op: "settle" },
  ]);
});

test("expectedTrace: a W before anything has been appended produces no step at all", () => {
  // There is no note to wait on yet, so the executor breaks out before logging anything.
  assert.deepEqual(expect("N1WAa"), [
    { op: "append", node: "n1", note: "a" },
    { op: "settle" },
  ]);
});

test("expectedTrace: several nodes left offline are all reconnected before the settle", () => {
  const steps = expect("N1DAaN2DAa");
  assert.deepEqual(steps.slice(-3), [
    { op: "connect", node: "n1" },
    { op: "connect", node: "n2" },
    { op: "settle" },
  ]);
});

test("actualTrace: a settle's one-row-per-note logging collapses into a single step", () => {
  // waitForSynced logs a `synced` per note; that is one settle, not three.
  const steps = actualTrace([
    { kind: "appended", node: "n1", note: "a" },
    { kind: "synced", note: "x", final: true },
    { kind: "synced", note: "y", final: true },
    { kind: "synced", note: "z", final: true },
  ]);
  assert.deepEqual(steps, [{ op: "append", node: "n1", note: "a" }, { op: "settle" }]);
});

test("actualTrace: `unsynced` marks the same step as `synced` — the step ran either way", () => {
  assert.deepEqual(actualTrace([{ kind: "unsynced", note: "x", final: true }]), [{ op: "settle" }]);
  assert.deepEqual(actualTrace([{ kind: "unsynced", note: "x", wait: "n2" }]), [{ op: "wait", node: "n2" }]);
});

test("actualTrace: poll/probe/snapshot chatter is ignored — it describes HOW an op went", () => {
  assert.deepEqual(actualTrace([
    { kind: "settle-poll", elapsedSec: 3 },
    { kind: "network-probe", node: "n1" },
    { kind: "pause-snapshot", seconds: 10 },
    { kind: "pausing", seconds: 10 },
  ]), [{ op: "pause", seconds: 10 }]);
});

test("traceMismatch: identical sequences match", () => {
  const h = normalize(parse("N1DN2P60AaWN1Aa"));
  const e = expectedTrace(h, opts);
  assert.equal(traceMismatch(e, [...e]), null);
});

test("traceMismatch: an op that should not exist is caught — the case per-op checks cannot see", () => {
  const e = expect("N1AaN2Aa");
  const withExtra: Step[] = [e[0], { op: "pause", seconds: 10 }, ...e.slice(1)];
  const m = traceMismatch(e, withExtra);
  assert.match(m ?? "", /step 2/);
  assert.match(m ?? "", /pause 10s/);
});

test("traceMismatch: a missing op is caught, and reports how far it got", () => {
  const e = expect("N1AaN2Aa");
  const m = traceMismatch(e, e.slice(0, 2));
  assert.match(m ?? "", /trace ends there \(2 of 3 steps ran\)/);
});

test("traceMismatch: the same ops on the WRONG node is caught", () => {
  const e = expect("N1AaN2Aa");
  const swapped: Step[] = [{ op: "append", node: "n2", note: "a" }, ...e.slice(1)];
  assert.match(traceMismatch(e, swapped) ?? "", /history says "append n1 a", trace says "append n2 a"/);
});

test("durationFloorSec: only the harness's OWN enforced waits count", () => {
  // 60s pause + one live W (4s quiet window) + the closing settle (15s). CLI/engine round-trips
  // are excluded on purpose: nothing guarantees a floor on them.
  assert.equal(floor("N1DN2P60AaWN1Aa"), 79);
});

test("durationFloorSec: a skipped W contributes nothing — it never waits", () => {
  assert.equal(floor("N1AaDW"), 15); // wait-skip + settle only
  assert.equal(floor("N1AaW"), 19); // a live W does count
});

test("durationFloorSec: honours the configured windows, so a fast-settle test run has a fast floor", () => {
  assert.equal(floor("N1AaW", { wSettleSec: 0.02, finalSettleSec: 0.02 }), 0.04);
});

test("durationFloorSec: pauses sum across the whole history", () => {
  assert.equal(floor("N1AaP10AaP20Aa", { wSettleSec: 0, finalSettleSec: 0 }), 30);
});
