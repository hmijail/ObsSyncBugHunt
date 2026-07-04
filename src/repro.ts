// Generate a standalone bash script that reproduces a DSL history's real commands, bypassing
// execute.ts/runHistory entirely — for manual debugging of one specific finding. Deliberately
// simplistic: no retries, no read-verify-token loop, no settle/quiet-window logic (see
// execute.ts for the real thing). The actual op implementations (Append/Wait/Disconnect/
// Connect/Pause/Check) live in scripts/repro-lib.sh, a small hand-maintained bash library every
// generated script sources — this file only translates the DSL into a flat call sequence.
//
//   --history       DSL string to reproduce                        (required)
//   --nodes         comma-separated container names, plus the literal "l" to include the local
//                    instance — e.g. "n1,n2,l" (default n1,n2). "l" is the sole on/off switch for
//                    the local instance (matches run.ts); --local-bin only supplies its binary
//                    path — required iff "l" is in --nodes, and a history using L without "l" in
//                    --nodes fails fast the same way run.ts does
//   --bin           CLI path inside the container                    (default /opt/obsidian/obsidian-cli)
//   --network       podman network                                   (default obsidian-net)
//   --local-bin     path to a local obsidian-cli binary — only used if "l" is in --nodes
//   --local-node-id the local instance's own Sync-reported device name (default: OS `hostname`)
//   --run-id        slug embedded in note names' trailing history part (default: the history itself)
//   --wait-cap-sec / --wait-poll-sec  bounded W-poll tuning           (default 60 / 2)
//   --out           where to write the script (mode 0755); default runs/<run-id>.sh; "-" prints
//                    to stdout instead of writing a file
//
// Note paths follow real reps' own convention, bughunt/<ts>-<letter>-<run-id> — the timestamp is
// generated fresh each time the SCRIPT ITSELF runs (not at generation time), so re-running the
// same script twice never collides with the first run's leftovers. Set VERBOSE=1 when invoking
// the generated script (e.g. `VERBOSE=1 runs/N1Aa.sh`) to echo every real command to stderr.
//
//   npm run repro -- --history N1DLAaWN1AaC --local-bin /path/to/obsidian-cli

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, serialize, normalize, usesLocal, DEFAULT_PAUSE_SEC, type History } from "./dsl.js";
import { nodeAddress } from "./isolate.js";
import { formatToken, NOTE_DIR } from "./types.js";
import { runProcess } from "./exec.js";

export interface ReproOpts {
  nodes: string[]; // container names, e.g. ["n1","n2"] (index 0 = node 1, etc.)
  bin: string; // container CLI path
  network: string; // podman network
  localBin?: string; // local-instance CLI path; required iff the history uses L
  localNodeId?: string; // the local instance's own node id, embedded in its tokens (same role as d.node)
  runId?: string; // slug embedded in note names; default: the (normalized) history string itself
  waitCapSec?: number; // bounded poll cap for Wait, default 60
  waitPollSec?: number; // poll interval, default 2
}

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

// scripts/repro-lib.sh, resolved from this file's own location (one level up from src/) — an
// absolute path, since the generated script can be printed to stdout and saved anywhere.
const LIB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "repro-lib.sh");

/** Single-quote a value for safe bash embedding (paths/tokens here never contain a `'`, but
 *  quoting costs nothing and guards against a future change). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Turn a (possibly un-normalized) DSL history into a standalone bash script that sources
 *  scripts/repro-lib.sh and calls its functions in sequence. Pure/synchronous — no I/O, no side
 *  effects. Throws a plain Error (message meant to be printed as-is, not a stack trace) for a
 *  malformed --run-id or a history that uses L without a configured local instance. */
export function generateScript(history: History, opts: ReproOpts): string {
  const h = normalize(history); // same canonicalization every history goes through before running
  if (usesLocal(h) && !opts.localBin) {
    throw new Error(`history "${serialize(h)}" uses L (the local node) but no --local-bin was given — pass --local-bin <path> or remove L from the history.`);
  }
  // Default to the history itself (already known safe as a filename/note-path component — the
  // DSL's own alphabet is a subset of RUN_ID_RE) rather than a timestamp, so both the script's
  // default filename and the notes it creates are self-describing at a glance.
  const runId = opts.runId ?? serialize(h);
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`--run-id "${runId}" must match ${RUN_ID_RE} (it's embedded in note paths)`);
  }
  const waitCapSec = opts.waitCapSec ?? 60;
  const waitPollSec = opts.waitPollSec ?? 2;

  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -u",
    `# ${serialize(h)}`,
    `source ${sq(LIB_PATH)}`,
    "",
    "VERBOSE=${VERBOSE:-0}", // plain string, not a template literal — must reach bash literally
    `BIN=${sq(opts.bin)}`,
    `NODES=(${opts.nodes.join(" ")})`,
    `NETWORK=${sq(opts.network)}`,
    `NOTE_DIR=${sq(NOTE_DIR)}`,
  ];
  if (opts.localBin) {
    lines.push(`LOCAL_BIN=${sq(opts.localBin)}`, `LOCAL_NODE_ID=${sq(opts.localNodeId ?? "local")}`);
  }
  lines.push(
    `RUN_ID=${sq(runId)}`,
    "TS=$(date +%dT%H%M%S)", // fresh per execution (not per generation) — see repro-lib.sh's Append/Check
    "SEQ=1",
    `WAIT_CAP_SEC=${waitCapSec}`,
    `WAIT_POLL_SEC=${waitPollSec}`,
    "",
  );

  for (let i = 0; i < opts.nodes.length; i++) {
    const { ip, mac } = nodeAddress(opts.nodes[i]);
    lines.push(`NODE_IP[${i + 1}]=${ip}`, `NODE_MACADDR[${i + 1}]=${mac}`);
  }
  lines.push("");

  const allSelectors = opts.nodes.map((_, i) => String(i + 1));
  if (opts.localBin) allSelectors.push("L");
  lines.push(`ALL_NODES=(${allSelectors.join(" ")})`, "");

  let activeNode: number | "local" = 1;
  let anyAppendYet = false;
  const offline = new Set<number>(); // node numbers left disconnected so far
  const tokensByLetter = new Map<string, string[]>(); // DSL letter -> tokens appended to it, in order
  const sel = (n: number | "local") => (n === "local" ? "L" : String(n));
  let seq = 0;

  for (const op of h) {
    switch (op.cmd) {
      case "node":
        activeNode = op.node!;
        break;
      case "local":
        activeNode = "local";
        break;
      case "pause":
        lines.push(`Pause ${op.seconds ?? DEFAULT_PAUSE_SEC}`, "");
        break;
      case "disconnect": {
        const n = activeNode as number;
        lines.push(`Disconnect ${n}`, "");
        offline.add(n);
        break;
      }
      case "connect": {
        const n = activeNode as number;
        lines.push(`Connect ${n}`, "");
        offline.delete(n);
        break;
      }
      case "wait":
        if (anyAppendYet) lines.push(`Wait ${sel(activeNode)}`, ""); // else a no-op, matches execute.ts
        break;
      case "append": {
        anyAppendYet = true;
        const letter = op.note!;
        lines.push(`Append ${sel(activeNode)} ${letter}`, "");
        seq++;
        const id = activeNode === "local" ? (opts.localNodeId ?? "local") : opts.nodes[activeNode - 1];
        const token = formatToken({ node: id, seq, note: letter });
        const list = tokensByLetter.get(letter);
        if (list) list.push(token); else tokensByLetter.set(letter, [token]);
        break;
      }
    }
  }

  // Final: reconnect anything still left offline (always — a disconnected node is a footgun
  // regardless of whether anything was ever appended); then, only if there's something to
  // verify, wait for every configured node/local instance to settle and check every appended token.
  for (const n of offline) lines.push(`Connect ${n}`, "");
  if (anyAppendYet) {
    for (const n of allSelectors) lines.push(`Wait ${n}`, "");
    for (const [letter, tokens] of tokensByLetter) lines.push(`Check ${letter} ${tokens.map(sq).join(" ")}`, "");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

// --- CLI glue -----------------------------------------------------------------
// Guarded so repro.test.ts can import generateScript without triggering this (parseArgs/
// process.exit on a test-runner invocation with no --history would otherwise fire on import).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { values } = parseArgs({
    options: {
      history: { type: "string" },
      nodes: { type: "string" },
      bin: { type: "string" },
      network: { type: "string" },
      "local-bin": { type: "string" },
      "local-node-id": { type: "string" },
      "run-id": { type: "string" },
      "wait-cap-sec": { type: "string" },
      "wait-poll-sec": { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.history) {
    console.error("Pass --history <dsl> (e.g. --history N1DLAaWN1AaC).");
    process.exit(2);
  }

  // "l" in --nodes is the sole on/off switch for local-instance participation, matching run.ts —
  // --local-bin only supplies its binary path.
  const rawNodes = (values.nodes ?? "n1,n2").split(",").map((s) => s.trim());
  const localRequested = rawNodes.includes("l");
  const nodes = rawNodes.filter((n) => n !== "l");
  const localBin = values["local-bin"];
  if (localRequested && !localBin) {
    console.error(`--nodes includes "l" but --local-bin/LOCAL_BIN wasn't provided — pass --local-bin <path> or drop "l" from --nodes.`);
    process.exit(2);
  }
  // Only worth a subprocess call when the local instance is actually requested — mirrors run.ts's
  // own hostname auto-detect (same caveat: a guess, not verified to match what Sync itself calls it).
  const localNodeId = localRequested ? (values["local-node-id"] ?? (await runProcess("hostname", [])).stdout.trim()) : undefined;

  let history: History;
  try {
    history = parse(values.history);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (usesLocal(normalize(history)) && !localRequested) {
    console.error(`history "${values.history}" uses L (the local node) but "l" isn't in --nodes — add it (e.g. --nodes ${[...nodes, "l"].join(",")}) or remove L from the history.`);
    process.exit(2);
  }

  // Resolved here (not left to generateScript's own default) so the same value can also name
  // the default output file below. Mirrors generateScript's own default exactly (the normalized
  // history string) — cheap and pure to recompute, not worth changing generateScript's return
  // type just to avoid one extra normalize/serialize call.
  const runId = values["run-id"] ?? serialize(normalize(history));

  let script: string;
  try {
    script = generateScript(history, {
      nodes,
      bin: values.bin ?? "/opt/obsidian/obsidian-cli",
      network: values.network ?? "obsidian-net",
      localBin: localRequested ? localBin : undefined,
      localNodeId,
      runId,
      waitCapSec: values["wait-cap-sec"] ? Number(values["wait-cap-sec"]) : undefined,
      waitPollSec: values["wait-poll-sec"] ? Number(values["wait-poll-sec"]) : undefined,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  // Default: write to runs/<run-id>.sh (executable) — a script whose whole point is to be run
  // shouldn't require the user to redirect+chmod it themselves every time. --out - prints to
  // stdout instead (e.g. for piping); --out <path> writes there instead of the default.
  if (values.out === "-") {
    console.log(script);
  } else {
    const outPath = values.out ?? path.join("runs", `${runId}.sh`);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, script, { mode: 0o755 });
    console.log(`wrote ${outPath}`);
  }
}
