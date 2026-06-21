// Per-run artifacts: an append-only event log (JSONL) + a final results.json.
// These are the auditable record a bug report is built from.

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class RunLogger {
  readonly dir: string;

  constructor(base = "runs", name = new Date().toISOString().replace(/[:.]/g, "-")) {
    this.dir = path.join(base, name);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Append one timestamped event (op, fault, milestone) to history.jsonl. */
  log(event: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(path.join(this.dir, "history.jsonl"), line + "\n");
    console.log(`· ${line}`);
  }

  /** Write the final verdict + observations. */
  results(obj: unknown): void {
    writeFileSync(path.join(this.dir, "results.json"), JSON.stringify(obj, null, 2));
    console.log(`→ results: ${path.join(this.dir, "results.json")}`);
  }
}
