// A correctness-assumption violation (unrecognized obsidian-cli output, a permanently-
// unresponsive CLI, or a CLI-vs-filesystem / read-vs-`files` disagreement) is NOT fatal:
// it's just another possible result of a rep, so a night-long soak keeps going. Each hit is
// classified, recorded to a durable per-category index, and tagged onto the rep dir. See
// docs/cli-trust.md.
//
//   -OBSFAIL : a client misreports its own vault (the CLI/FS or read-vs-`files` disagreement)
//              — a real finding (e.g. the forum "phantom conflict file" bug).
//   -UNKNOWN : we couldn't judge — unparseable CLI output (parser needs updating) or a
//              permanently-unresponsive CLI. Also the verdict ladder's catch-all.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CliUnrecognizedOutput } from "./cli-parse.js";

/** Thrown for a correctness-assumption violation — the untrusted CLI/black-box said something
 *  internally inconsistent; `runRep` catches it and turns it into a per-rep outcome via
 *  `describeInconsistency`. Throwing (rather than handling in place) keeps the conditions
 *  unit-testable and lets one `try/catch` choke point cover every throw site. */
export class CliInconsistencyError extends Error {
  constructor(readonly reason: string, readonly detail: Record<string, unknown> = {}) {
    super(`inconsistency: ${reason}`);
    this.name = "CliInconsistencyError";
  }
}

export type InconsistencyCategory = "obsfail" | "unknown";

/** Reasons that mean "a client misreported its own vault" → a real finding (`-OBSFAIL`).
 *  Everything else (permanently-unresponsive, and every unparseable output) is `-UNKNOWN`. */
const OBSFAIL_REASONS = new Set(["cli-fs-disagreement", "cli-listing-inconsistent"]);

export function categoryOf(err: unknown): InconsistencyCategory {
  if (err instanceof CliInconsistencyError && OBSFAIL_REASONS.has(err.reason)) return "obsfail";
  return "unknown";
}

const SUFFIX: Record<InconsistencyCategory, string> = { obsfail: "-OBSFAIL", unknown: "-UNKNOWN" };

/** Shell-quote an argv so a logged CLI line is copy-paste-runnable. Bare tokens (the common
 *  case — `read`, `file=bughunt/x`) are left alone; anything with whitespace or shell-special
 *  characters is single-quoted (with `'\''` escaping for embedded quotes). */
export function quoteArgv(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_=:./@,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(" ");
}

/** The originating throw site: the first `…/src/<file>:line:col` stack frame that isn't the
 *  error-class constructor file (inconsistency.ts / cli-parse.ts), i.e. the driver/runner/execute
 *  line that issued the call. Under tsx the stack references the .ts source. */
export function siteOf(err: Error): string | undefined {
  const lines = (err.stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    const m = /(\/[^\s()]*\/src\/[^\s():]+:\d+:\d+)/.exec(line);
    if (!m) continue;
    const loc = m[1];
    // Skip the generic throw plumbing — the error-class constructors and the driver's
    // `expect` wrapper — so we land on the method line that invoked the recognizer (the
    // line a dev edits), not the rethrow point.
    if (/\/src\/inconsistency\.ts:/.test(loc) || /\/src\/cli-parse\.ts:/.test(loc)) continue;
    if (/ObsidianDriver\.expect\b/.test(line)) continue;
    // Trim to the repo-relative `src/...:line` for a compact, clickable site.
    return loc.replace(/^.*\/(src\/[^\s]+)$/, "$1");
  }
  return undefined;
}

export interface InconsistencyRecord {
  reason: string;
  category: InconsistencyCategory;
  suffix: string;
  recognizer?: string; // the parse function that failed — the one to teach the new output shape
  command?: string;
  site?: string;
  stdout?: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** Build the structured, copy-paste-friendly record for a caught inconsistency. */
export function describeInconsistency(err: CliInconsistencyError | CliUnrecognizedOutput): InconsistencyRecord {
  const category = categoryOf(err);
  const rec: InconsistencyRecord = {
    reason: err instanceof CliInconsistencyError ? err.reason : "unrecognized-cli-output",
    category,
    suffix: SUFFIX[category],
    site: siteOf(err),
    at: new Date().toISOString(),
  };
  if (err instanceof CliUnrecognizedOutput) {
    rec.recognizer = err.recognizer;
    rec.command = quoteArgv(err.raw.argv);
    rec.stdout = err.raw.stdout;
  } else {
    rec.detail = err.detail;
  }
  return rec;
}

/** Append the record to its durable per-category index (`<runsDir>/OBSFAIL.log` /
 *  `<runsDir>/UNKNOWN.log`) so the morning-after triage file name already says which kind it
 *  was. `runsDir` defaults to plain "runs" (unchanged behavior); run.ts passes its
 *  `--runs-prefix`-aware root. Never exits. */
export function recordInconsistency(rec: InconsistencyRecord, runsDir = "runs"): void {
  try {
    mkdirSync(runsDir, { recursive: true });
    appendFileSync(path.join(runsDir, `${rec.suffix.slice(1)}.log`), JSON.stringify(rec) + "\n");
  } catch {
    /* even if we can't persist, the caller still prints the compact console line */
  }
}
