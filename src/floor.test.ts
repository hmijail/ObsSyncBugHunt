import test from "node:test";
import assert from "node:assert/strict";
import { parse, normalize } from "./dsl.js";
import { historyDurationExpectedMinSec } from "./floor.js";

const floor = (h: string): number => historyDurationExpectedMinSec(normalize(parse(h)));

test("historyDurationExpectedMinSec: pauses dominate, D/C/A are 0.1s each, W and selectors nothing", () => {
  assert.equal(floor("N1DN2P60AaWN1Aa"), 60.3); // 60 + 0.1×(D,A,A); the W is free
});

test("historyDurationExpectedMinSec: pauses sum across the whole history", () => {
  assert.equal(floor("N1AaP10AaP20Aa"), 30.3);
});

test("historyDurationExpectedMinSec: an op normalize removed contributes nothing — it never runs", () => {
  // The W is on the offline n1, so normalize drops it and the floor must not charge for it.
  assert.equal(floor("N1AaDW"), floor("N1AaD"));
  assert.equal(floor("N1AaD"), 0.2);
});

test("historyDurationExpectedMinSec: a history of pure selectors floors at zero", () => {
  assert.equal(floor("N1N2"), 0);
});

test("historyDurationExpectedMinSec: fractional sums stay exact enough to print", () => {
  assert.equal(floor("N1AaAbAc"), 0.3); // not 0.30000000000000004
});

test("historyDurationExpectedMinSec: a W is free — it can legitimately return instantly", () => {
  // It used to contribute a nominal 2s for its quiescent window. There is no window now: with
  // nothing outstanding it returns on its first poll, so any term at all would be a floor that
  // ordinary histories breach on a fast driver. A floor is a lower bound, not an expectation.
  assert.equal(historyDurationExpectedMinSec(normalize(parse("N1AaW"))), 0.1);
  assert.equal(historyDurationExpectedMinSec(normalize(parse("N1AaW30"))), 0.1);
});
