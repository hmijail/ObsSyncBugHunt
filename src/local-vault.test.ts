import test from "node:test";
import assert from "node:assert/strict";
import { UNRECOGNIZED, parseVaultList } from "./cli-parse.js";
import { resolveVaultName, vaultGuardVerdict, requireActiveVault, LocalVaultMismatch } from "./local-vault.js";
import type { ObsidianDriver } from "./driver.js";

// The guard exists because `vault=` is accepted and then ignored (see src/local-vault.ts's header
// for the measurements). Every test below is really the same question: when the harness cannot
// PROVE it is on the requested vault, does it refuse? The answer must be yes in every branch,
// because the caller's next action is a write.

// Real `vaults verbose` output, captured 2026-09-21 against obsidian-cli 1.13.7.
const VAULTS_TSV = [
  "throwaway\t/Users/x/IGNORED_BY_BACKUPS/ObsidianVaults/throwaway",
  "Notes-iCloud\t/Users/x/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes-iCloud",
  "Obsidian Sandbox\t/Users/x/Library/Application Support/obsidian/Obsidian Sandbox",
].join("\n");

const KNOWN = parseVaultList(VAULTS_TSV) as Exclude<ReturnType<typeof parseVaultList>, symbol>;

// --- parseVaultList ---------------------------------------------------------------------------

test("parseVaultList: name/path split on the FIRST tab, so a path with spaces survives", () => {
  assert.deepEqual(KNOWN[2], { name: "Obsidian Sandbox", path: "/Users/x/Library/Application Support/obsidian/Obsidian Sandbox" });
  assert.equal(KNOWN.length, 3);
});

test("parseVaultList: a listing with no tabs is UNRECOGNIZED, not a path-less half-answer", () => {
  // This is `vaults` without `verbose`. Accepting it would silently strip the paths the error
  // message exists to show, which is the only reason this is parsed at all.
  assert.equal(parseVaultList("throwaway\nNotes-iCloud"), UNRECOGNIZED);
});

test("parseVaultList: empty and Error: are UNRECOGNIZED", () => {
  assert.equal(parseVaultList(""), UNRECOGNIZED); // Obsidian always knows at least the open vault
  assert.equal(parseVaultList("   \n "), UNRECOGNIZED);
  assert.equal(parseVaultList("Error: Sync is in error state."), UNRECOGNIZED);
  assert.equal(parseVaultList("throwaway\t/p\nError: boom"), UNRECOGNIZED); // one bad line spoils it
});

// --- resolveVaultName -------------------------------------------------------------------------

test("resolveVaultName: exact match wins", () => {
  assert.deepEqual(resolveVaultName(KNOWN, "throwaway"), { status: "exact", name: "throwaway" });
});

test("resolveVaultName: 'Throwaway' resolves to 'throwaway' — the exact mismatch that shipped as the default", () => {
  assert.deepEqual(resolveVaultName(KNOWN, "Throwaway"), { status: "case-insensitive", name: "throwaway" });
});

test("resolveVaultName: an unknown name is unknown, never the nearest thing", () => {
  assert.deepEqual(resolveVaultName(KNOWN, "Throwawy"), { status: "unknown" });
  assert.deepEqual(resolveVaultName([], "throwaway"), { status: "unknown" });
});

test("resolveVaultName: two vaults differing only in case is ambiguous, not a coin flip", () => {
  const both = [{ name: "notes", path: "/a" }, { name: "Notes", path: "/b" }];
  assert.deepEqual(resolveVaultName(both, "NOTES"), { status: "ambiguous", matches: ["notes", "Notes"] });
  // ...but an exact hit still resolves, because it is unambiguous by construction.
  assert.deepEqual(resolveVaultName(both, "Notes"), { status: "exact", name: "Notes" });
});

// --- vaultGuardVerdict: the refusals ------------------------------------------------------------

test("vaultGuardVerdict: the requested vault IS the active one -> ok, canonical name returned", () => {
  const v = vaultGuardVerdict({ requested: "throwaway", active: "throwaway", known: KNOWN });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.canonical, "throwaway");
});

test("vaultGuardVerdict: case-only difference from the active vault pins the CLI's OWN spelling", () => {
  // The CLI compares vault= exactly, so echoing the user's spelling back at it would produce a
  // pin that silently matches nothing.
  const v = vaultGuardVerdict({ requested: "Throwaway", active: "throwaway", known: KNOWN });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.canonical, "throwaway");
});

test("vaultGuardVerdict: REFUSES when the active vault is a different one — the whole point", () => {
  const v = vaultGuardVerdict({ requested: "throwaway", active: "Notes-iCloud", known: KNOWN });
  assert.equal(v.ok, false);
  // The message has to carry both names and say why vault= will not rescue it, or the reader
  // "fixes" it by passing vault= harder.
  assert.match(v.ok === false ? v.message : "", /throwaway/);
  assert.match(v.ok === false ? v.message : "", /Notes-iCloud/);
  assert.match(v.ok === false ? v.message : "", /does NOT switch vaults/);
});

test("vaultGuardVerdict: REFUSES when the name probe did not answer (fail closed)", () => {
  const v = vaultGuardVerdict({ requested: "throwaway", active: null, known: KNOWN });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.message : "", /could not read the active vault/);
});

test("vaultGuardVerdict: REFUSES a vault Obsidian has never heard of, and lists the real ones", () => {
  const v = vaultGuardVerdict({ requested: "Throwawy", active: "Notes-iCloud", known: KNOWN });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.message : "", /does not know a vault named/);
  assert.match(v.ok === false ? v.message : "", /Notes-iCloud/);
});

test("vaultGuardVerdict: REFUSES on ambiguity rather than picking one", () => {
  const both = [{ name: "notes", path: "/a" }, { name: "Notes", path: "/b" }];
  const v = vaultGuardVerdict({ requested: "NOTES", active: "notes", known: both });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.message : "", /more than one vault/);
});

test("vaultGuardVerdict: an unparseable listing still DECIDES — it is advisory, not load-bearing", () => {
  // Losing `vaults verbose` costs the hint, not the guard: a match still runs, a mismatch still
  // refuses. Degrading to "allow" here would reintroduce the bug on the day that output drifts.
  const match = vaultGuardVerdict({ requested: "Throwaway", active: "throwaway", known: null });
  assert.equal(match.ok, true);
  assert.equal(match.ok && match.canonical, "throwaway");

  const mismatch = vaultGuardVerdict({ requested: "throwaway", active: "Notes-iCloud", known: null });
  assert.equal(mismatch.ok, false);
});

// --- requireActiveVault: the two probes, wired --------------------------------------------------

/** Minimal stand-in: only the two probes the guard calls. */
function fakeDriver(name: unknown, list: unknown): ObsidianDriver {
  return {
    vaultNameProbe: async () => name,
    vaultListProbe: async () => list,
  } as unknown as ObsidianDriver;
}

test("requireActiveVault: returns the canonical name when the active vault matches", async () => {
  const d = fakeDriver({ status: "ok", name: "throwaway" }, { status: "ok", vaults: KNOWN });
  assert.equal(await requireActiveVault(d, "Throwaway"), "throwaway");
});

test("requireActiveVault: throws LocalVaultMismatch on the wrong vault", async () => {
  const d = fakeDriver({ status: "ok", name: "Notes-iCloud" }, { status: "ok", vaults: KNOWN });
  await assert.rejects(() => requireActiveVault(d, "throwaway"), LocalVaultMismatch);
});

test("requireActiveVault: a TIMED-OUT name probe aborts — it never proceeds on 'probably fine'", async () => {
  const d = fakeDriver({ status: "timeout" }, { status: "ok", vaults: KNOWN });
  await assert.rejects(() => requireActiveVault(d, "throwaway"), LocalVaultMismatch);
});

test("requireActiveVault: an UNRECOGNIZED name probe aborts too", async () => {
  const d = fakeDriver({ status: "unrecognized", raw: "???" }, { status: "ok", vaults: KNOWN });
  await assert.rejects(() => requireActiveVault(d, "throwaway"), LocalVaultMismatch);
});

test("requireActiveVault: a failed LISTING probe does not block a confirmed match", async () => {
  const d = fakeDriver({ status: "ok", name: "throwaway" }, { status: "timeout" });
  assert.equal(await requireActiveVault(d, "throwaway"), "throwaway");
});
