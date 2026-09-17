// Executors decouple "which Obsidian CLI to run" from "how to reach it".
// The same ObsidianDriver code works locally (dev / smoke testing) and against
// a container (`<engine> exec <container> obsidian ...`, engine per engine.ts).

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { engineBin } from "./engine.js";
import type { ExecResult } from "./types.js";

/** One batched round trip. `outputs` has one entry per requested command, in order, and `killed`
 *  says which of them ran out of time individually. `ok` is false only when the whole transport
 *  failed or the reply could not be split into exactly that many parts — in which case `outputs` is
 *  empty and the caller must fall back rather than parse a guess. */
export interface BatchResult {
  ok: boolean;
  outputs: string[];
  /** Per command: did it hit its own cap? A killed command's output is whatever it managed to emit,
   *  usually nothing — the flag is what makes that distinguishable from a genuinely empty reply. */
  killed: boolean[];
  raw: ExecResult;
}

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

  /**
   * Run several CLI invocations in ONE round trip, returning each one's stdout separately.
   *
   * Worth having because the round trip is the entire cost: a `docker exec /bin/true` measured 68ms
   * against these containers, while `read`, `create` and `open` measured 62-66ms each — i.e. the
   * Obsidian work in them is below the noise floor of the exec itself. Four calls batched went from
   * 259ms to 71ms (measured 2026-09-06, 10 iterations).
   *
   * Each command's output is returned as its own string, so every parser still sees exactly what it
   * would have seen alone — the positively-recognized-output discipline in docs/cli-trust.md is not
   * relaxed by batching, only the transport is shared. A batch that cannot be split apart with
   * confidence is reported as a failure rather than guessed at.
   *
   * OPTIONAL: an executor that does not implement it (the test stubs) simply gets the sequential
   * path in `ObsidianDriver.batch`, which is the same calls in the same order with the same
   * parsing — only slower. Nothing may depend on a batch being atomic.
   *
   * `perCmdMs` bounds commands INDIVIDUALLY, overriding `timeoutMs` where present and leaving the
   * rest exactly as they were. It exists because a batch can mix a call that must be bounded with
   * one that must not: the write path prepends `sync:history` (the call most likely to block on a
   * node with no network) to an `append` that is deliberately unbounded, since a write killed
   * mid-flight is an apparatus failure rather than a slow answer.
   */
  execBatch?(cmds: string[][], opts?: { timeoutMs?: number; perCmdMs?: (number | undefined)[] }): Promise<BatchResult>;
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
      // killSignal SIGKILL: the default SIGTERM is ignored by a wedged container-engine CLI, so
      // the timeout wouldn't actually fire (a real 763s hang was seen, under podman). SIGKILL
      // makes the cap real, so `killed` is a trustworthy "untimely" signal for the retry loop.
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
  async execBatch(cmds: string[][], opts?: { timeoutMs?: number; perCmdMs?: (number | undefined)[] }) {
    // No container to amortise here — the local instance is invoked directly, so batching would buy
    // nothing and a shell would only add quoting hazards. Run them in order and report the same
    // shape, so callers need no special case for the local node. A command that runs out of time is
    // recorded as killed and the REST STILL RUN, matching the container path.
    const outputs: string[] = [];
    const killed: boolean[] = [];
    let last: ExecResult | null = null;
    for (let i = 0; i < cmds.length; i++) {
      last = await runProcess(this.obsidianBin, cmds[i], opts?.perCmdMs?.[i] ?? opts?.timeoutMs);
      outputs.push(last.stdout);
      killed.push(last.killed);
    }
    return { ok: outputs.length === cmds.length, outputs, killed, raw: last! };
  }
}

/** Runs the Obsidian CLI inside a container, through whichever engine engine.ts resolved. */
export class ContainerExecutor implements Executor {
  constructor(
    private readonly container: string,
    private readonly obsidianBin: string,
    readonly id = container,
  ) {}
  exec(args: string[], opts?: { timeoutMs?: number }) {
    return runProcess(engineBin(), ["exec", this.container, this.obsidianBin, ...args], opts?.timeoutMs);
  }
  shell(argv: string[], opts?: { timeoutMs?: number }) {
    return runProcess(engineBin(), ["exec", this.container, ...argv], opts?.timeoutMs);
  }
  async execBatch(cmds: string[][], opts?: { timeoutMs?: number; perCmdMs?: (number | undefined)[] }) {
    // A nonce marker, not a fixed string: note content is attacker-free but arbitrary, and a note
    // that happened to contain the separator would silently mis-split the batch into the wrong
    // number of parts. Random per call, so it cannot be present in content written before it.
    const mark = `__B${randomBytes(9).toString("hex")}__`;
    // EACH COMMAND IS BOUNDED INDIVIDUALLY, by `timeout` inside the container, and the marker
    // carries its exit status. One outer cap on the whole batch meant a single slow command took
    // the others down with it — measured: 16 samples lost in a 20s rep, every lane of that node
    // blanked at once, because `sync:status` blocks while a node syncs. Now the slow one is killed
    // on its own (exit 124) and its neighbours still answer.
    const boundsMs = cmds.map((_, i) => opts?.perCmdMs?.[i] ?? opts?.timeoutMs);
    const bound = (ms: number | undefined): string => ms === undefined ? "" : `timeout ${(ms / 1000).toFixed(3)} `;
    const script = cmds
      .map((c, i) => `${bound(boundsMs[i])}${shq(this.obsidianBin)} ${c.map(shq).join(" ")}; printf '%s %s\n' ${shq(mark)} "$?"`)
      .join("; ");
    // The OUTER cap is now only a backstop against the shell itself wedging, so it must be larger
    // than every inner bound put together or it would reintroduce exactly what this removes. One
    // UNBOUNDED command makes the whole batch unbounded — anything else would cap a command the
    // caller deliberately left uncapped, which is the write path's case.
    const outerMs = boundsMs.some((b) => b === undefined)
      ? undefined
      : boundsMs.reduce((a, b) => a! + b!, 0)! + 5_000;
    const raw = await runProcess(engineBin(), ["exec", this.container, "sh", "-c", script], outerMs);
    if (raw.killed) return { ok: false, outputs: [], killed: [], raw };
    const parts = raw.stdout.split(new RegExp(`${mark} (\\d+)\n`));
    // split() with one capture group yields [out, code, out, code, ..., trailing]. Anything else
    // means the reply is not the shape we asked for, and splitting it further would be invention.
    if (parts.length !== cmds.length * 2 + 1) return { ok: false, outputs: [], killed: [], raw };
    const outputs: string[] = [];
    const killed: boolean[] = [];
    for (let i = 0; i < cmds.length; i++) {
      outputs.push(parts[i * 2]);
      killed.push(parts[i * 2 + 1] === "124"); // GNU timeout's "I killed it" status
    }
    return { ok: true, outputs, killed, raw };
  }
}

/** Single-quote for `sh -c`. Note names and content are ours, not hostile, but they do contain
 *  spaces, parentheses and newlines — all of which a bare interpolation would mangle. */
const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
