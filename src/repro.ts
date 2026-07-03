// Generate a standalone bash script that reproduces a DSL history's real commands, bypassing
// execute.ts/runHistory entirely — for manual debugging of one specific finding. Deliberately
// simplistic: no retries, no read-verify-token loop, no settle/quiet-window logic (see
// execute.ts for the real thing). The actual op implementations (Append/Wait/Disconnect/
// Connect/Pause/Check) live in scripts/repro-lib.sh, a small hand-maintained bash library every
// generated script sources — this file only translates the DSL into a flat call sequence.
//
//   --history       DSL string to reproduce                        (required)
//   --nodes         comma-separated container names                 (default n1,n2)
//   --bin           CLI path inside the container                    (default /opt/obsidian/obsidian-cli)
//   --network       podman network                                   (default obsidian-net)
//   --mac-bin       path to a local obsidian-cli binary — required iff --history contains M
//   --mac-node-id   the Mac's own Sync-reported device name           (default: OS `hostname`)
//   --run-id        slug embedded in note names                      (default repro-<timestamp>)
//   --wait-cap-sec / --wait-poll-sec  bounded W-poll tuning           (default 60 / 2)
//   --out           write the script to a file (mode 0755) instead of printing it to stdout
//
//   npm run repro -- --history N1DMAaWN1AaC --mac-bin /path/to/obsidian-cli

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse, serialize, normalize, usesMac, DEFAULT_PAUSE_SEC, type History } from "./dsl.js";
import { nodeAddress } from "./isolate.js";
import { formatToken, NOTE_DIR } from "./types.js";
import { runProcess } from "./exec.js";

export interface ReproOpts {
  nodes: string[]; // container names, e.g. ["n1","n2"] (index 0 = node 1, etc.)
  bin: string; // container CLI path
  network: string; // podman network
  macBin?: string; // Mac CLI path; required iff the history uses M
  macNodeId?: string; // the Mac's own node id, embedded in its tokens (same role as d.node)
  runId?: string; // slug embedded in note names; default repro-<timestamp>
  waitCapSec?: number; // bounded poll cap for Wait, default 60
  waitPollSec?: number; // poll interval, default 2
}

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

// scripts/repro-lib.sh, resolved from this file's own location (one level up from src/) — an
// absolute path, since the generated script can be printed to stdout and saved anywhere.
const LIB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "repro-lib.sh");

function tsStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Single-quote a value for safe bash embedding (paths/tokens here never contain a `'`, but
 *  quoting costs nothing and guards against a future change). */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Turn a (possibly un-normalized) DSL history into a standalone bash script that sources
 *  scripts/repro-lib.sh and calls its functions in sequence. Pure/synchronous — no I/O, no side
 *  effects. Throws a plain Error (message meant to be printed as-is, not a stack trace) for a
 *  malformed --run-id or a history that uses M without a configured Mac. */
export function generateScript(history: History, opts: ReproOpts): string {
  const h = normalize(history); // same canonicalization every history goes through before running
  if (usesMac(h) && !opts.macBin) {
    throw new Error(`history "${serialize(h)}" uses M (the Mac node) but no --mac-bin was given — pass --mac-bin <path> or remove M from the history.`);
  }
  const runId = opts.runId ?? `repro-${tsStamp()}`;
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
    `BIN=${sq(opts.bin)}`,
    `NODES=(${opts.nodes.join(" ")})`,
    `NETWORK=${sq(opts.network)}`,
    `NOTE_DIR=${sq(NOTE_DIR)}`,
  ];
  if (opts.macBin) {
    lines.push(`MAC_BIN=${sq(opts.macBin)}`, `MAC_NODE_ID=${sq(opts.macNodeId ?? "mac")}`);
  }
  lines.push(`RUN_ID=${sq(runId)}`, "SEQ=1", `WAIT_CAP_SEC=${waitCapSec}`, `WAIT_POLL_SEC=${waitPollSec}`, "");

  for (let i = 0; i < opts.nodes.length; i++) {
    const { ip, mac } = nodeAddress(opts.nodes[i]);
    lines.push(`NODE_IP[${i + 1}]=${ip}`, `NODE_MACADDR[${i + 1}]=${mac}`);
  }
  lines.push("");

  const allSelectors = opts.nodes.map((_, i) => String(i + 1));
  if (opts.macBin) allSelectors.push("M");
  lines.push(`ALL_NODES=(${allSelectors.join(" ")})`, "");

  let activeNode: number | "mac" = 1;
  let anyAppendYet = false;
  const offline = new Set<number>(); // node numbers left disconnected so far
  const tokensByLetter = new Map<string, string[]>(); // DSL letter -> tokens appended to it, in order
  const sel = (n: number | "mac") => (n === "mac" ? "M" : String(n));
  let seq = 0;

  for (const op of h) {
    switch (op.cmd) {
      case "node":
        activeNode = op.node!;
        break;
      case "mac":
        activeNode = "mac";
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
        const id = activeNode === "mac" ? (opts.macNodeId ?? "mac") : opts.nodes[activeNode - 1];
        const token = formatToken({ node: id, seq, note: letter });
        const list = tokensByLetter.get(letter);
        if (list) list.push(token); else tokensByLetter.set(letter, [token]);
        break;
      }
    }
  }

  // Final: reconnect anything still left offline (always — a disconnected node is a footgun
  // regardless of whether anything was ever appended); then, only if there's something to
  // verify, wait for every configured node/Mac to settle and check every appended token.
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
      "mac-bin": { type: "string" },
      "mac-node-id": { type: "string" },
      "run-id": { type: "string" },
      "wait-cap-sec": { type: "string" },
      "wait-poll-sec": { type: "string" },
      out: { type: "string" },
    },
  });

  if (!values.history) {
    console.error("Pass --history <dsl> (e.g. --history N1DMAaWN1AaC).");
    process.exit(2);
  }

  const macBin = values["mac-bin"];
  // Only worth a subprocess call when the Mac is actually configured — mirrors run.ts's own
  // hostname auto-detect (same caveat: a guess, not verified to match what Sync itself calls it).
  const macNodeId = macBin ? (values["mac-node-id"] ?? (await runProcess("hostname", [])).stdout.trim()) : undefined;

  let history: History;
  try {
    history = parse(values.history);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  let script: string;
  try {
    script = generateScript(history, {
      nodes: (values.nodes ?? "n1,n2").split(",").map((s) => s.trim()),
      bin: values.bin ?? "/opt/obsidian/obsidian-cli",
      network: values.network ?? "obsidian-net",
      macBin,
      macNodeId,
      runId: values["run-id"],
      waitCapSec: values["wait-cap-sec"] ? Number(values["wait-cap-sec"]) : undefined,
      waitPollSec: values["wait-poll-sec"] ? Number(values["wait-poll-sec"]) : undefined,
    });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  if (values.out) {
    writeFileSync(values.out, script, { mode: 0o755 });
    console.log(`wrote ${values.out}`);
  } else {
    console.log(script);
  }
}
