import test from "node:test";
import assert from "node:assert/strict";
import {
  UNRECOGNIZED, isNotFoundError,
  parseRead, parseFilesList, parseSyncStatus, parseTotal, parseSyncRead,
  parseSyncVersions, parseFileVersions, parseMutation,
} from "./cli-parse.js";

// Samples are the real obsidian-cli outputs captured 2026-06-26 (see docs/cli-trust.md).

test("parseRead: content present, not-found absent, empty/unknown-error UNRECOGNIZED", () => {
  assert.deepEqual(parseRead("(op-n1-2)\n(op-n1-4)"), { present: true, content: "(op-n1-2)\n(op-n1-4)" });
  assert.deepEqual(parseRead('Error: File "bughunt/x" not found.'), { present: false });
  assert.equal(parseRead(""), UNRECOGNIZED);          // empty is never a positive answer
  assert.equal(parseRead("   \n  "), UNRECOGNIZED);
  assert.equal(parseRead("Error: something else entirely"), UNRECOGNIZED); // unknown error
});

test("parseFilesList: paths ok (incl empty), Error line UNRECOGNIZED", () => {
  assert.deepEqual(parseFilesList("bughunt/a.md\nbughunt/b.md"), ["bughunt/a.md", "bughunt/b.md"]);
  assert.deepEqual(parseFilesList(""), []); // empty list — caller must confirm emptiness
  assert.equal(parseFilesList("Error: boom"), UNRECOGNIZED);
});

test("parseSyncStatus: known status ok, unknown status UNRECOGNIZED", () => {
  assert.deepEqual(parseSyncStatus("status: synced\nvault: TA2\nvault size: 4.88 MB"), { status: "synced" });
  assert.deepEqual(parseSyncStatus("status: syncing"), { status: "syncing" });
  assert.equal(parseSyncStatus("status: teleporting"), UNRECOGNIZED); // unseen → learn it
  assert.equal(parseSyncStatus(""), UNRECOGNIZED);
  assert.equal(parseSyncStatus("vault: TA2"), UNRECOGNIZED); // no status line
});

test("parseTotal: integer | absent | UNRECOGNIZED", () => {
  assert.equal(parseTotal("1"), 1);
  assert.equal(parseTotal("0"), 0);
  assert.equal(parseTotal('Error: File "x" not found.'), "absent");
  assert.equal(parseTotal(""), UNRECOGNIZED);
  assert.equal(parseTotal("twelve"), UNRECOGNIZED);
});

test("parseSyncRead: content after ---, no-version, absent, junk", () => {
  const ok = "bughunt/a.md (version 0, 2026-06-26 14:59:36)\n---\n(op-n1-2)\n(op-n1-4)";
  assert.deepEqual(parseSyncRead(ok), { kind: "content", content: "(op-n1-2)\n(op-n1-4)" });
  assert.deepEqual(parseSyncRead("Error: Failed to retrieve version: Version 999 not found. File has 1 versions (0-0)."), { kind: "no-version" });
  assert.deepEqual(parseSyncRead('Error: File "x" not found.'), { kind: "absent" });
  assert.equal(parseSyncRead("garbage without a header"), UNRECOGNIZED);
  assert.equal(parseSyncRead(""), UNRECOGNIZED);
});

test("parseSyncVersions: rows ok, absent, Error-row UNRECOGNIZED", () => {
  const out = parseSyncVersions("bughunt/a.md\n1   Sync  2026-06-26 14:59:36        67 B  [n1]");
  assert.deepEqual(out, [{ version: 1, source: "Sync", timestamp: "2026-06-26 14:59:36", size: "67 B", device: "n1" }]);
  assert.equal(parseSyncVersions('Error: File "x" not found.'), "absent");
  assert.equal(parseSyncVersions(""), UNRECOGNIZED);
  assert.equal(parseSyncVersions("Error: weird"), UNRECOGNIZED);
});

test("parseFileVersions: rows ok, absent", () => {
  const out = parseFileVersions("1   2026-06-26 14:59   67 B");
  assert.deepEqual(out, [{ version: 1, timestamp: "2026-06-26 14:59", size: "67 B" }]);
  assert.equal(parseFileVersions('Error: File "x" not found.'), "absent");
});

test("parseMutation: known success lines ok, else UNRECOGNIZED", () => {
  assert.equal(parseMutation("Created: bughunt/a.md"), "ok");
  assert.equal(parseMutation("Appended to: bughunt/a.md"), "ok");
  assert.equal(parseMutation("Deleted permanently: bughunt/a.md"), "ok");
  assert.equal(parseMutation("Opened: bughunt/a.md"), "ok");
  assert.equal(parseMutation(""), UNRECOGNIZED);
  assert.equal(parseMutation("Error: nope"), UNRECOGNIZED);
});

test("isNotFoundError matches only the canonical absent form", () => {
  assert.equal(isNotFoundError('Error: File "bughunt/x" not found.'), true);
  assert.equal(isNotFoundError("Error: Failed to retrieve version: …"), false);
  assert.equal(isNotFoundError("(op-n1-1)"), false);
});
