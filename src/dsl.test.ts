import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, serialize, type History } from "./dsl.js";

test("parses the worked example N1DEaAC", () => {
  const h = parse("N1DEaAC");
  assert.deepEqual(h, [
    { cmd: "node", node: 1 },
    { cmd: "disconnect" },
    { cmd: "select", note: "a" },
    { cmd: "append" },
    { cmd: "connect" },
  ]);
});

test("parse ignores whitespace and parses pauses", () => {
  assert.deepEqual(parse("N1EaA N2A"), [
    { cmd: "node", node: 1 },
    { cmd: "select", note: "a" },
    { cmd: "append" },
    { cmd: "node", node: 2 },
    { cmd: "append" },
  ]);
  assert.deepEqual(parse("DP C"), [{ cmd: "disconnect" }, { cmd: "pause", seconds: 10 }, { cmd: "connect" }]);
  assert.deepEqual(parse("P30"), [{ cmd: "pause", seconds: 30 }]);
});

test("round-trips serialize(parse(s)) for canonical strings", () => {
  for (const s of ["N1DEaAC", "N1EaAN2A", "N1DEaAWCWN2W", "EaAP30C", "N2EbA"]) {
    assert.equal(serialize(parse(s)), s);
  }
});

test("round-trips parse(serialize(h))", () => {
  const h: History = [
    { cmd: "node", node: 2 },
    { cmd: "select", note: "b" },
    { cmd: "append" },
    { cmd: "wait" },
    { cmd: "pause", seconds: 10 },
  ];
  assert.deepEqual(parse(serialize(h)), h);
});

test("rejects malformed strings", () => {
  assert.throws(() => parse("N"), /node number/);
  assert.throws(() => parse("E"), /note letter/);
  assert.throws(() => parse("Z"), /unexpected/);
});
