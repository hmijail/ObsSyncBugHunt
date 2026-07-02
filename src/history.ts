// Per-rep artifact: one append-only event log (JSONL) — everything about a rep (the DSL
// history, every step, the final verdict) is a line in it. See docs — no more separate
// meta/history/results files: they either duplicated jsonl events or were never read.

import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export class RunLogger {
  readonly path: string;
  private readonly start = Date.now(); // rep start, for relative timestamps

  constructor(base = "runs", name = new Date().toISOString().replace(/[:.]/g, "-")) {
    mkdirSync(base, { recursive: true });
    this.path = path.join(base, `${name}.jsonl`);
  }

  /** Append one event. Relative time `t` (seconds since rep start) leads so a plain-text read
   *  is easy to eyeball; the noisy absolute `ts` trails at the end. */
  log(event: Record<string, unknown>): void {
    const t = Number(((Date.now() - this.start) / 1000).toFixed(3));
    const line = JSON.stringify({ t, ...event, ts: new Date().toISOString() });
    appendFileSync(this.path, line + "\n");
    console.log(`· ${line}`);
  }

  /** Write the final verdict + observations for `run-local.ts`'s separate single-node
   *  pipeline-check path (the containerized soak logs its own `results` event via `log()`). */
  results(obj: unknown): void {
    const p = this.path.replace(/\.jsonl$/, "-results.json");
    writeFileSync(p, JSON.stringify(obj, null, 2));
    console.log(`→ results: ${p}`);
  }
}
