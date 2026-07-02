// Per-run artifacts: an append-only event log (JSONL) + a final results.json.
// These are the auditable record a bug report is built from.

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class RunLogger {
  readonly dir: string;
  private readonly start = Date.now(); // rep start, for relative timestamps

  constructor(base = "runs", name = new Date().toISOString().replace(/[:.]/g, "-")) {
    this.dir = path.join(base, name);
    mkdirSync(this.dir, { recursive: true });
  }

  /** Append one event to history.jsonl. Relative time `t` (seconds since rep start) leads so
   *  a plain-text read is easy to eyeball; the noisy absolute `ts` trails at the end. */
  log(event: Record<string, unknown>): void {
    const t = Number(((Date.now() - this.start) / 1000).toFixed(3));
    const line = JSON.stringify({ t, ...event, ts: new Date().toISOString() });
    appendFileSync(path.join(this.dir, "history.jsonl"), line + "\n");
    console.log(`· ${line}`);
  }

  /** Write the final verdict + observations. */
  results(obj: unknown): void {
    writeFileSync(path.join(this.dir, "results.json"), JSON.stringify(obj, null, 2));
    console.log(`→ results: ${path.join(this.dir, "results.json")}`);
  }

  /** Write an arbitrary named artifact (e.g. the generated history) into the run dir. */
  artifact(filename: string, obj: unknown): void {
    writeFileSync(path.join(this.dir, filename), JSON.stringify(obj, null, 2));
  }
}
