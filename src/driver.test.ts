import test from "node:test";
import assert from "node:assert/strict";
import { isAbsentRead, isConflictFile } from "./driver.js";

test("isAbsentRead: empty / not-found read counts as absent (Bug B)", () => {
  // `read` exits 0 even when the note is missing, so absence is content-based.
  assert.equal(isAbsentRead(undefined), true);
  assert.equal(isAbsentRead(""), true);
  assert.equal(isAbsentRead("   "), true);
  assert.equal(isAbsentRead('Error: File "286040-a" not found.'), true);
  assert.equal(isAbsentRead("base [op-n1-1]"), false);
});

test("isConflictFile matches the (Conflicted copy …) pattern", () => {
  assert.equal(isConflictFile("shared (Conflicted copy n2 202606211146).md"), true);
  assert.equal(isConflictFile("shared.md"), false);
});
