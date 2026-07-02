// Executors decouple "which Obsidian CLI to run" from "how to reach it".
// The same ObsidianDriver code works locally (dev / smoke testing) and against
// a Podman container (`podman exec <container> obsidian ...`).

import { execFile } from "node:child_process";
import type { ExecResult } from "./types.js";

export interface Executor {
  /** A short label used as the NodeId in history (e.g. "local", "n1"). */
  readonly id: string;
  /** `opts.timeoutMs` bounds THIS call (default 120s). Used by the settle's bounded
   *  `sync:status` probe: that command blocks until synced, so a short cap turns it into a
   *  pollable "synced yet?" — a timeout (killed) means "still syncing". */
  exec(args: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
  /** Run a raw command in the node's environment (e.g. `ls`/`cat` on the vault FS).
   *  Used as the independent second source when the CLI can't positively answer.
   *  `opts.timeoutMs` bounds THIS call (default 120s), same as `exec`. */
  shell(argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult>;
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
      // killSignal SIGKILL: the default SIGTERM is ignored by a wedged `podman`, so the
      // timeout wouldn't actually fire (a real 763s hang was seen). SIGKILL makes the
      // cap real, so `killed` is a trustworthy "untimely" signal for the retry loop.
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number; killed?: boolean }) | null;
        const code = e && typeof e.code === "number" ? e.code : err ? 1 : 0;
        const killed = e?.killed === true;
        const extra = killed ? ` [killed after ${timeoutMs}ms]` : "";
        resolve({
          argv: [file, ...args],
          code,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") + extra,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          killed,
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
  exec(args: string[], opts?: { timeoutMs?: number }) {
    return runProcess(this.obsidianBin, args, opts?.timeoutMs);
  }
  shell(argv: string[], opts?: { timeoutMs?: number }) {
    return runProcess(argv[0], argv.slice(1), opts?.timeoutMs);
  }
}

/** Runs the Obsidian CLI inside a Podman container. */
export class PodmanExecutor implements Executor {
  constructor(
    private readonly container: string,
    private readonly obsidianBin: string,
    readonly id = container,
  ) {}
  exec(args: string[], opts?: { timeoutMs?: number }) {
    return runProcess("podman", ["exec", this.container, this.obsidianBin, ...args], opts?.timeoutMs);
  }
  shell(argv: string[], opts?: { timeoutMs?: number }) {
    return runProcess("podman", ["exec", this.container, ...argv], opts?.timeoutMs);
  }
}
