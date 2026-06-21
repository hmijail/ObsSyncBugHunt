// Executors decouple "which Obsidian CLI to run" from "how to reach it".
// The same ObsidianDriver code works locally (dev / smoke testing) and against
// a Podman container (`podman exec <container> obsidian ...`).

import { execFile } from "node:child_process";
import type { ExecResult } from "./types.js";

export interface Executor {
  /** A short label used as the NodeId in history (e.g. "local", "n1"). */
  readonly id: string;
  exec(args: string[]): Promise<ExecResult>;
}

/**
 * Run an arbitrary process, capturing stdout/stderr/exit into an ExecResult.
 *
 * `timeoutMs` guards against hangs: notably `sync:status` blocks ~20s+ while a
 * vault is `syncing` (it returns immediately only when `synced`), so a wedged
 * call must not stall the harness — on timeout the child is killed and the call
 * reports a non-zero code (treated downstream as "status unknown").
 */
export function runProcess(
  file: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<ExecResult> {
  const startedAt = new Date();
  return new Promise((resolve) => {
    // Array args => no shell => no quoting concerns for spaces/newlines.
    execFile(
      file,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number; killed?: boolean }) | null;
        const code = e && typeof e.code === "number" ? e.code : err ? 1 : 0;
        const extra = e?.killed ? ` [killed after ${timeoutMs}ms]` : "";
        resolve({
          argv: [file, ...args],
          code,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") + extra,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
        });
      },
    );
  });
}

/** Runs the Obsidian CLI directly on this machine. */
export class LocalExecutor implements Executor {
  constructor(
    private readonly obsidianBin: string,
    readonly id = "local",
  ) {}
  exec(args: string[]) {
    return runProcess(this.obsidianBin, args);
  }
}

/** Runs the Obsidian CLI inside a Podman container. */
export class PodmanExecutor implements Executor {
  constructor(
    private readonly container: string,
    private readonly obsidianBin: string,
    readonly id = container,
  ) {}
  exec(args: string[]) {
    return runProcess("podman", ["exec", this.container, this.obsidianBin, ...args]);
  }
}
