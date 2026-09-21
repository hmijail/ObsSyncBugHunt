// Smoke test: exercises the driver against a LOCAL throwaway vault and prints
// raw CLI output, so we can confirm the real formats of read/files/diff/history
// before building parsers on them.
//
//   npm run smoke -- --vault throwaway [--bin obsidian] [--settle-ms 10000]
//
// Requirements:
//   - --vault names a *throwaway* vault (never a real one), and that vault is the one Obsidian
//     currently has OPEN. This is checked before anything is written — `vault=` cannot switch
//     vaults, so being open is the only way to target one. See src/local-vault.ts.
//   - Obsidian is running with the CLI enabled (the CLI talks to the app).

import { parseArgs } from "node:util";
import { LocalExecutor } from "./exec.js";
import { ObsidianDriver } from "./driver.js";
import { LocalVaultMismatch, requireActiveVault } from "./local-vault.js";
import { DEFAULT_LOCAL_BIN, NOTE_DIR } from "./types.js";
import type { OpResult } from "./types.js";

const { values } = parseArgs({ options: { vault: { type: "string" }, bin: { type: "string" }, "settle-ms": { type: "string" } } });
const bin = values.bin ?? DEFAULT_LOCAL_BIN;
const vault = values.vault;

if (!vault) {
  console.error(
    "Pass --vault <name> for a throwaway vault (never a real one).",
  );
  process.exit(2);
}

// Sync uploads aren't instant; wait before querying sync-version state.
const settleMs = Number(values["settle-ms"] ?? 10000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const drv = new ObsidianDriver(new LocalExecutor(bin));

// BEFORE the first write. Everything below this line mutates a real vault (including a
// `delete permanent`), so the vault has to be confirmed first, not hoped for.
try {
  await requireActiveVault(drv, vault);
} catch (e) {
  if (e instanceof LocalVaultMismatch) {
    console.error(`\nsmoke: refusing to run — ${e.message}\n`);
    process.exit(2);
  }
  throw e;
}

// Under bughunt/ like every other harness note, so a throwaway vault's own notes
// are never touched (the final `delete permanent` only ever removes this one).
const note = `${NOTE_DIR}/smoke-${Date.now()}`;

function show(label: string, r: OpResult<unknown>) {
  console.log(`\n=== ${label}  (code=${r.raw.code}, ok=${r.ok}) ===`);
  console.log(r.ok ? r.value : `ERROR: ${r.error}`);
}

show("create", await drv.createNote(note, "base line"));
show("append #1", await drv.appendLine(note, "line A op-local-1-aaaa"));
show("append #2", await drv.appendLine(note, "line B op-local-2-bbbb"));
show("read", await drv.read(note));
show("files", await drv.listFiles());

console.log(`\n(settling ${settleMs}ms for Sync to upload…)`);
await sleep(settleMs);

show("diff filter=sync", await drv.diffSync(note));
show("history", await drv.history(note));
show("delete (permanent)", await drv.deleteNote(note, true));
