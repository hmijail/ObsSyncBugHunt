import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, normalize, type History } from "./dsl.js";

test("parses the worked example N1DAaC", () => {
  const h = parse("N1DAaC");
  assert.deepEqual(h, [
    { cmd: "node", node: 1 },
    { cmd: "disconnect" },
    { cmd: "append", note: "a" },
    { cmd: "connect" },
  ]);
});

test("parse ignores whitespace and parses pauses", () => {
  assert.deepEqual(parse("N1Aa N2Aa"), [
    { cmd: "node", node: 1 },
    { cmd: "append", note: "a" },
    { cmd: "node", node: 2 },
    { cmd: "append", note: "a" },
  ]);
  assert.deepEqual(parse("DP C"), [{ cmd: "disconnect" }, { cmd: "pause", seconds: 10 }, { cmd: "connect" }]);
  assert.deepEqual(parse("P30"), [{ cmd: "pause", seconds: 30 }]);
});

test("round-trips serialize(parse(s)) for canonical strings", () => {
  for (const s of ["N1DAaC", "N1AaN2Aa", "N1DAaWCWN2W", "AaP30C", "N2Ab"]) {
    assert.equal(serialize(parse(s)), s);
  }
});

test("round-trips parse(serialize(h))", () => {
  const h: History = [
    { cmd: "node", node: 2 },
    { cmd: "append", note: "b" },
    { cmd: "wait" },
    { cmd: "pause", seconds: 10 },
  ];
  assert.deepEqual(parse(serialize(h)), h);
});

test("rejects malformed strings", () => {
  assert.throws(() => parse("N"), /node number/);
  assert.throws(() => parse("A"), /note letter/);
  assert.throws(() => parse("E"), /unexpected/); // selection mode is gone
  assert.throws(() => parse("Z"), /unexpected/);
});

// --- normalize ---------------------------------------------------------------

const norm = (s: string) => serialize(normalize(parse(s)));

test("normalize: a floating pause moves to the next action; the emptied node section vanishes", () => {
  assert.equal(norm("N1PN2Aa"), "N2PAa"); // P not adjacent to an action → floats before Aa; N1 drops
});

test("normalize: a pause adjacent to an action stays put", () => {
  assert.equal(norm("N1DPN2Aa"), "N1DPN2Aa"); // P right after D (an action) is anchored
  assert.equal(norm("N1PAa"), "N1PAa"); // P right before A (an action) is anchored
});

test("normalize: a floating pause with no following action is dropped", () => {
  assert.equal(norm("N1AaN2P"), "N1Aa"); // trailing P after a node-only tail → gone (N2 too)
});

test("normalize: floated pauses sum and redundant nodes collapse", () => {
  assert.equal(norm("N1PPN2Aa"), "N2P20Aa");
});

test("normalize: adjacent same-note appends collapse; different notes don't", () => {
  assert.equal(norm("N1AaAa"), "N1Aa");
  assert.equal(norm("N1AaAb"), "N1AaAb");
});

test("normalize is idempotent", () => {
  for (const s of ["N1PN2Aa", "N1DPN2Aa", "N1AaAaN2Ab", "N1PPN2Aa"]) {
    assert.equal(norm(norm(s)), norm(s));
  }
});
