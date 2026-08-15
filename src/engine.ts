// Which container engine drives the nodes, and what that engine can actually do.
//
// The harness was written against Podman and now also runs on Docker. For everything the harness
// does (build/run/rm/exec/cp/inspect/ps, network create/rm/connect/disconnect) the two CLIs take
// the same arguments — with the divergences listed under `connectPinsMac` and in the Makefile's
// `net` target.
//
// Two questions are deliberately kept apart here:
//
//   1. WHICH BINARY to invoke — a name (`engineBin`). Cheap, synchronous, needed on the hot path.
//   2. WHAT IT CAN DO — never inferred from that name. Podman ships a `docker`-named shim
//      (podman-docker), so "the binary is called docker" does NOT imply Docker semantics, and
//      Docker may grow a flag Podman has today. So capabilities are PROBED from the binary
//      itself (`--help` output), the same "trust the reply text, not an assumption" rule the
//      rest of this repo applies to obsidian-cli (see docs/cli-trust.md).
//
// Override the choice with CONTAINER_ENGINE=<binary> (a bare name on PATH, or an absolute path).

import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

/**
 * Minimal one-shot process capture for the probes below.
 *
 * Deliberately NOT exec.ts's `runProcess`: exec.ts has to ask this module which binary to run,
 * and importing back the other way would make the two modules circular. These probes need only
 * the combined output of a `--version`/`--help` call, none of ExecResult's timing/kill
 * bookkeeping, so a few lines here buy a one-way dependency (exec.ts -> engine.ts, never back).
 */
function capture(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15_000 }, (_err, stdout, stderr) =>
      // Ignore the error: a missing binary or an unknown subcommand is itself an answer here
      // ("this engine can't do that"), and every caller below judges the TEXT, never the status.
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`));
  });
}

/** Engines we know how to look for, in preference order. Podman first: if both are installed,
 *  the podman one is the one this project was developed against. */
const CANDIDATES = ["podman", "docker"];

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

/** Test seam: forget the memoized binary/capability probes (nothing else should call this). */
export function resetEngineCache(): void {
  binCache = undefined;
  macCache = undefined;
  versionCache = undefined;
}

let versionCache: Promise<string> | undefined;

/**
 * The engine's own self-report (`<engine> --version`), e.g. "podman version 5.4.0" or
 * "Docker version 29.7.2, build a7dcaa6". Recorded alongside the Obsidian version in each rep's
 * `history` event: a finding is only meaningful next to the whole stack that produced it, and the
 * engine decides real things here (see `connectPinsMac`).
 */
export function engineVersion(): Promise<string> {
  versionCache ??= capture(engineBin(), ["--version"]).then((out) => out.trim() || "?");
  return versionCache;
}

let macCache: Promise<boolean> | undefined;

/**
 * Can `<engine> network connect` re-pin a container's MAC address?
 *
 * Podman: yes (`--mac-address`). Docker: no — the flag does not exist, and the plausible
 * `--driver-opt com.docker.network.endpoint.{mac_address,macaddress,mac-address}` spellings were
 * tried against Docker 29.7.2 and are all accepted silently (exit 0) while a fresh random MAC is
 * assigned anyway. `--ip` does work on both, so a Docker reconnect keeps the node's IP and loses
 * only its MAC — see docs/DESIGN.md for why we pin either in the first place, and why losing the
 * MAC is a tolerable difference rather than a blocker.
 *
 * Probed from `network connect --help` rather than switched on the engine's name: the question is
 * whether the flag is there, and only the binary in front of us can answer that.
 */
export function connectPinsMac(): Promise<boolean> {
  macCache ??= capture(engineBin(), ["network", "connect", "--help"])
    .then((out) => out.includes("--mac-address"));
  return macCache;
}
