import test from "node:test";
import assert from "node:assert/strict";
import { parse, normalize } from "./dsl.js";
import { durationFloorSec } from "./floor.js";

const floor = (h: string): number => durationFloorSec(normalize(parse(h)));

test("durationFloorSec: pauses dominate, W's are worth 2s, other ops 0.1s, selectors nothing", () => {
  assert.equal(floor("N1DN2P60AaWN1Aa"), 62.3); // 60 + 2 + 0.1×(D,A,A)
});

test("durationFloorSec: pauses sum across the whole history", () => {
  assert.equal(floor("N1AaP10AaP20Aa"), 30.3);
});

test("durationFloorSec: an op normalize removed contributes nothing — it never runs", () => {
  // The W is on the offline n1, so normalize drops it and the floor must not charge 2s for it.
  assert.equal(floor("N1AaDW"), floor("N1AaD"));
  assert.equal(floor("N1AaD"), 0.2);
});

test("durationFloorSec: a history of pure selectors floors at zero", () => {
  assert.equal(floor("N1N2"), 0);
});

test("durationFloorSec: fractional sums stay exact enough to print", () => {
  assert.equal(floor("N1AaAbAc"), 0.3); // not 0.30000000000000004
});

test("durationFloorSec: a short configured settle window lowers the per-W term, never raises it", () => {
  // A run told to settle for 0.02s cannot be held to the 2s nominal — the unit tests drive exactly
  // this. A longer window does NOT push the term above the nominal: the margin is the point.
  assert.equal(durationFloorSec(normalize(parse("N1AaW")), 0.02), 0.12);
  assert.equal(durationFloorSec(normalize(parse("N1AaW")), 30), 2.1);
});
