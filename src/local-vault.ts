// The local instance's "am I actually pointed at the vault I was told to use" guard.
//
// WHY THIS EXISTS. `--vault <name>` on the local entry points (smoke.ts, run-local.ts) reads like
// a safety interlock: name a throwaway vault, and the harness will work in that one. It was not.
// The flag was parsed, checked for presence, and then never used again — a required argument with
// no effect, guarding nothing.
//
// That would be a small bug if `vault=<name>` worked. It does not, and it does not FAIL either:
// it reaches only the vault Obsidian currently has FOCUSED, and silently discards any other name —
// a closed vault, a vault open in a SECOND window, or a string that names no vault at all. No
// error, no warning, no non-zero exit.
//
// Re-derive it rather than trusting this comment: `make probe-vault-param` prints what the CLI
// does on the machine in front of you, and `make check-assumptions` (step 10) fails if the
// behaviour changes. The reasoning, including why an earlier and weaker version of this claim
// survived for months, is in docs/DESIGN.md, "Targeting the local vault".
//
// Put together: `make smoke TEST_VAULT=throwaway` would run `create`, two `append`s and a
// `delete permanent` against whatever real vault happened to be open, while every comment in
// sight promised a throwaway one. Bounded to bughunt/, but pointed at the wrong vault entirely.
//
// THE FIX IS NOT TO PASS vault= HARDER. It is to stop treating the flag as an instruction and
// start treating it as an ASSERTION about the world: ask the CLI which vault it is really on, and
// refuse to run unless that is the vault that was asked for. The user switches vaults in the GUI;
// the harness only ever verifies. Fail closed — an unanswered probe aborts, exactly like every
// other "positively recognized or nothing" rule in this project.

import type { ObsidianDriver } from "./driver.js";
import type { VaultEntry } from "./cli-parse.js";

/** Thrown when the active vault is not the requested one, or when that could not be established.
 *  Deliberately its own type (not CliInconsistencyError): this is a refusal to START, not a rep
 *  outcome — there is no run to score yet, and the caller exits rather than logging a verdict. */
export class LocalVaultMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalVaultMismatch";
  }
}

/** Resolve a requested vault name against the vaults Obsidian actually knows about.
 *
 *  Exact match wins. Failing that, a UNIQUE case-insensitive match is accepted and reported, so
 *  `Throwaway` finds `throwaway` — that exact mismatch shipped as the Makefile's default and was
 *  invisible precisely because nothing ever checked the name. Case-insensitivity is a convenience
 *  for the human typing the flag; it is NOT a loosening of the guard, because whatever it resolves
 *  to is still compared against the active vault by exact name afterwards.
 *
 *  Ambiguity (two vaults differing only in case) is an error rather than a coin flip. */
export type VaultResolution =
  | { status: "exact"; name: string }
  | { status: "case-insensitive"; name: string }
  | { status: "unknown" }
  | { status: "ambiguous"; matches: string[] };

export function resolveVaultName(known: VaultEntry[], requested: string): VaultResolution {
  if (known.some((v) => v.name === requested)) return { status: "exact", name: requested };
  const folded = known.filter((v) => v.name.toLowerCase() === requested.toLowerCase());
  if (folded.length === 1) return { status: "case-insensitive", name: folded[0].name };
  if (folded.length > 1) return { status: "ambiguous", matches: folded.map((v) => v.name) };
  return { status: "unknown" };
}

/** The whole decision, as a pure function of what the two probes saw.
 *
 *  Split out from the I/O so the interesting part — every way this is allowed to REFUSE — is unit
 *  testable without a live Obsidian. `active: null` means the probe did not answer; `known: null`
 *  means the listing did not parse (advisory, so the guard still decides, it just can't offer
 *  alternatives).
 *
 *  Returns the CANONICAL name on success — the CLI's own spelling, not the user's, since that
 *  is what any later comparison (the drift baseline in run.ts) has to match exactly. */
export type VaultVerdict =
  | { ok: true; canonical: string; note?: string }
  | { ok: false; message: string };

export function vaultGuardVerdict(args: {
  requested: string;
  active: string | null;
  known: VaultEntry[] | null;
}): VaultVerdict {
  const { requested, active, known } = args;

  // Fail closed. Not knowing which vault we are on is the same danger as being on the wrong one:
  // the next call is a write.
  if (active === null) {
    return {
      ok: false,
      message:
        `could not read the active vault (\`vault info=name\` did not answer).\n` +
        `  Refusing to run: the next thing this would do is WRITE, and there is no way to tell\n` +
        `  which vault it would write to. Is Obsidian running, with the CLI enabled\n` +
        `  (Settings > General > Advanced > Command line interface)?`,
    };
  }

  const resolution = known ? resolveVaultName(known, requested) : null;

  if (resolution?.status === "ambiguous") {
    return {
      ok: false,
      message:
        `"${requested}" matches more than one vault, differing only in case: ` +
        `${resolution.matches.join(", ")}.\n  Pass the exact name.`,
    };
  }

  if (resolution?.status === "unknown") {
    return {
      ok: false,
      message:
        `Obsidian does not know a vault named "${requested}".\n` +
        `  Known vaults: ${known!.map((v) => v.name).join(", ")}\n` +
        `  (active right now: ${active})`,
    };
  }

  // Without a parsed listing we cannot canonicalize, so compare against the requested spelling
  // directly — still case-insensitively, for the same convenience reason as above.
  const canonical = resolution?.name ?? requested;

  if (canonical.toLowerCase() !== active.toLowerCase()) {
    return {
      ok: false,
      message:
        `requested vault "${requested}" is not the one Obsidian has active ("${active}").\n` +
        `  obsidian-cli's \`vault=\` does NOT switch vaults — it reaches only the FOCUSED vault and\n` +
        `  silently ignores any other name, so running now would operate on "${active}" instead.\n` +
        `  Open "${canonical}" in Obsidian and re-run` +
        (known ? `, or pass --vault ${active} if that is really the vault you meant.` : `.`),
    };
  }

  // Active matches, but only up to case — return the CLI's own spelling, since that is what a
  // later exact comparison against it will see.
  if (canonical !== active) {
    return { ok: true, canonical: active, note: `resolved "${requested}" to the active vault "${active}"` };
  }
  if (resolution?.status === "case-insensitive") {
    return { ok: true, canonical, note: `resolved "${requested}" to "${canonical}"` };
  }
  return { ok: true, canonical };
}

/**
 * Verify the local Obsidian is on `requested`, and return the canonical vault name.
 *
 * Both probes are bounded and non-retrying: this runs once, before anything is written, and a
 * hang here must not look like a slow start. The name probe is load-bearing (no answer → abort);
 * the listing is advisory (no answer → carry on with a thinner error message if it comes to that).
 *
 * Throws LocalVaultMismatch on any refusal. Callers exit non-zero — there is nothing to fall back
 * to, and falling back is what caused this.
 */
export async function requireActiveVault(
  driver: ObsidianDriver,
  requested: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 15_000;

  const nameProbe = await driver.vaultNameProbe(timeoutMs);
  const active = nameProbe.status === "ok" ? nameProbe.name : null;

  const listProbe = await driver.vaultListProbe(timeoutMs);
  const known = listProbe.status === "ok" ? listProbe.vaults : null;

  const verdict = vaultGuardVerdict({ requested, active, known });
  if (!verdict.ok) throw new LocalVaultMismatch(verdict.message);
  if (verdict.note) console.log(`vault guard: ${verdict.note}`);
  console.log(`vault guard: operating on "${verdict.canonical}" (confirmed active).`);
  return verdict.canonical;
}
