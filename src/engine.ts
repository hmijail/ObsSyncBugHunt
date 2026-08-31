// Which container engine drives the nodes.
//
// The harness was written against Podman and now also runs on Docker. For everything the harness
// does (build/run/rm/exec/cp/inspect/ps, network create/rm/connect/disconnect) the two CLIs take
// the same arguments and the same flags, so there is no engine-specific codepath anywhere in the
// harness — only the Makefile's `net` target, which passes an explicit `--subnet` because the two
// engines have different defaults.
//
// This module therefore answers only two things: which binary to invoke (`engineBin` — cheap and
// synchronous, it is on the hot path) and what it calls itself (`engineVersion`, recorded with
// every rep because the engine is part of the stack under test).
//
// NOTE for anyone re-introducing an engine-specific behaviour here: do NOT branch on the binary's
// NAME. Podman ships a `docker`-named shim (podman-docker), so "the binary is called docker" does
// not imply Docker semantics. Probe the capability from the binary itself (`--help` output) — the
// same "trust the reply text, not an assumption" rule this repo applies to obsidian-cli (see
// docs/cli-trust.md). There used to be exactly one such probe, `connectPinsMac`; git history has
// it if a similar one is ever needed.
//
// Override the choice with CONTAINER_ENGINE=<binary> (a bare name on PATH, or an absolute path).

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * Minimal one-shot process capture for the `--version` probe below.
 *
 * Deliberately NOT exec.ts's `runProcess`: exec.ts has to ask this module which binary to run,
 * and importing back the other way would make the two modules circular. These probes need only
 * the combined output of a `--version` call, none of ExecResult's timing/kill bookkeeping,
 * so a few lines here buy a one-way dependency (exec.ts -> engine.ts, never back).
 */
function capture(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000 }, (_err, stdout, stderr) =>
      // Ignore the error: a missing binary or an unknown subcommand is itself an answer here,
      // and the caller below judges the TEXT, never the status.
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`));
  });
}

/** Engines we know how to look for, in preference order.
 *
 *  Docker first. On an unknown machine `docker` is the likelier right call: Podman ships a real
 *  `docker` executable via the podman-docker package, so on those hosts it reaches podman anyway
 *  — harmlessly, since nothing here behaves differently per engine (see the header note).
 *
 *  Podman stays in the list because that fallback does real work. A shell `alias docker=podman`
 *  (the advice people usually mean) is invisible here — `execFile` spawns without a shell, so an
 *  alias yields ENOENT — and macOS/brew has no podman-docker package at all. On those hosts only
 *  the real `podman` binary exists, and finding it is what keeps the harness working. */
const CANDIDATES = ["docker", "podman"];

function onPath(name: string): boolean {
  if (name.includes(path.sep)) {
    try { accessSync(name, constants.X_OK); return true; } catch { return false; }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, name), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

let binCache: string | undefined;

/**
 * The container-engine binary every `<engine> exec` / `<engine> network ...` call goes through.
 * Resolved once per process from CONTAINER_ENGINE, else the first of CANDIDATES found on PATH.
 *
 * Falls back to the last candidate rather than throwing when none is installed: the real,
 * legible error then comes from the actual command ("docker: command not found" against a
 * visible argv) instead of from an import-time crash far from the call site.
 */
export function engineBin(): string {
  if (binCache) return binCache;
  const override = process.env.CONTAINER_ENGINE?.trim();
  binCache = override || CANDIDATES.find(onPath) || CANDIDATES[CANDIDATES.length - 1];
  return binCache;
}

/** Test seam: forget the memoized probes (nothing else should call this). */
export function resetEngineCache(): void {
  binCache = undefined;
  versionCache = undefined;
}

let versionCache: Promise<string> | undefined;

/**
 * The engine's own self-report (`<engine> --version`), e.g. "podman version 5.4.0" or
 * "Docker version 29.7.2, build a7dcaa6". Recorded alongside the Obsidian version in each rep's
 * `history` event: a finding is only meaningful next to the whole stack that produced it, and the
 * engine is part of the stack under test, not neutral scaffolding.
 */
export function engineVersion(): Promise<string> {
  versionCache ??= capture(engineBin(), ["--version"]).then((out) => out.trim() || "?");
  return versionCache;
}
