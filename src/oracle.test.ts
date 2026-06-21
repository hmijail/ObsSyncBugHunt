import test from "node:test";
import assert from "node:assert/strict";
import { checkNote, type AckedEdit, type NodeObservation } from "./oracle.js";

const NOTE = "shared";
const acked: AckedEdit[] = [
  { note: NOTE, node: "n1", token: "op-n1-1-aaaa" },
  { note: NOTE, node: "n2", token: "op-n2-1-bbbb" },
];

test("clean merge: both tokens in identical canonical on both nodes", () => {
  const base = "base\nop-n1-1-aaaa\nop-n2-1-bbbb";
  const obs: NodeObservation[] = [
    { node: "n1", note: NOTE, canonical: base, conflicts: [] },
    { node: "n2", note: NOTE, canonical: base, conflicts: [] },
  ];
  const v = checkNote(NOTE, acked, obs);
  assert.equal(v.ok, true);
  assert.equal(v.converged, true);
  assert.deepEqual(v.lost, []);
});

test("conflict-file mode: a token preserved only via a conflict file is OK", () => {
  const canonical = "base\nop-n1-1-aaaa";
  const conflict = {
    file: "shared (Conflicted copy n2 202606211146).md",
    content: "base\nop-n2-1-bbbb",
  };
  const obs: NodeObservation[] = [
    { node: "n1", note: NOTE, canonical, conflicts: [conflict] },
    { node: "n2", note: NOTE, canonical, conflicts: [conflict] },
  ];
  const v = checkNote(NOTE, acked, obs);
  assert.equal(v.ok, true);
  assert.deepEqual(v.onlyInConflict, ["op-n2-1-bbbb"]);
});

test("missing conflict file => lost token => failure (the target bug)", () => {
  const canonical = "base\nop-n1-1-aaaa"; // n2's acknowledged edit is nowhere
  const obs: NodeObservation[] = [
    { node: "n1", note: NOTE, canonical, conflicts: [] },
    { node: "n2", note: NOTE, canonical, conflicts: [] },
  ];
  const v = checkNote(NOTE, acked, obs);
  assert.equal(v.ok, false);
  assert.deepEqual(v.lost, ["op-n2-1-bbbb"]);
});

test("duplication => failure", () => {
  const dup = "base\nop-n1-1-aaaa\nop-n1-1-aaaa\nop-n2-1-bbbb";
  const obs: NodeObservation[] = [
    { node: "n1", note: NOTE, canonical: dup, conflicts: [] },
    { node: "n2", note: NOTE, canonical: dup, conflicts: [] },
  ];
  const v = checkNote(NOTE, acked, obs);
  assert.equal(v.ok, false);
  assert.equal(v.duplicated[0]?.token, "op-n1-1-aaaa");
  assert.equal(v.duplicated[0]?.maxCount, 2);
});

test("divergence => failure (nodes disagree on canonical)", () => {
  const obs: NodeObservation[] = [
    { node: "n1", note: NOTE, canonical: "base\nop-n1-1-aaaa\nop-n2-1-bbbb", conflicts: [] },
    { node: "n2", note: NOTE, canonical: "base\nop-n2-1-bbbb", conflicts: [] },
  ];
  const v = checkNote(NOTE, acked, obs);
  assert.equal(v.converged, false);
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.perNodeMissing.find((p) => p.node === "n2")?.missing,
    ["op-n1-1-aaaa"],
  );
});
