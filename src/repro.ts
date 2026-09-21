// Generate a standalone bash script that reproduces a DSL history's real commands, bypassing
// execute.ts/runHistory entirely — for manual debugging of one specific finding. Deliberately
// simplistic: no retries, no server-version-counter corroboration, no settle machinery (see
// execute.ts for the real thing). Its `W` IS token-aware, though — that is what `W` MEANS, not a
// robustness detail, and a repro whose waits return at a different moment races differently and
// reproduces nothing. See WaitFor in repro-lib.sh. The actual op implementations (Append/Wait/Disconnect/
// Connect/Pause/Check) live in scripts/repro-lib.sh, a small hand-maintained bash library every
// generated script sources — this file only translates the DSL into a flat call sequence.
//
//   --history       DSL string to reproduce                        (required). Its own content
//                    determines which containers/local instance the generated script needs (see
//                    dsl.ts's requiredNodes) — there's no separate --nodes flag to keep in sync.
//   --bin           CLI path inside the container                    (default /opt/obsidian/obsidian-cli)
//   --network       container network                                (default obsidian-net)
//   --local-bin     path to a local obsidian-cli binary (default: obsidian, relying on the normal
//                    install/activation flow's PATH entry) — only actually used if --history uses L
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
import { parseArgs } from "node:util";
import { parse, serialize, normalize, usesLocal, requiredNodes, DEFAULT_PAUSE_SEC, type History } from "./dsl.js";
import { nodeIp } from "./isolate.js";
import { DEFAULT_LOCAL_BIN, formatToken, NOTE_DIR } from "./types.js";
import { runProcess } from "./exec.js";

export interface ReproOpts {
  containers: number[]; // the N<d> numbers this history needs — container names are always
                         // literally n<d> by convention (see execute.ts's driverOf), so there's
                         // nothing else to configure per-container
  bin: string; // container CLI path
  network: string; // container network
  localBin?: string; // local-instance CLI path; required iff the history uses L
  localNodeId?: string; // the local instance's own node id, embedded in its tokens (same role as d.node)
  runId?: string; // slug embedded in note names; default: the (normalized) history string itself
  waitCapSec?: number; // bounded poll cap for Wait, default 60
  waitPollSec?: number; // poll interval, default 2
}

const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

// How the generated script finds scripts/repro-lib.sh at RUN time. Resolved from the script's own
// location, never baked in as an absolute path: a repro is a thing you paste into a bug report,
// commit, or hand to someone else, and one carrying `/Users/<whoever>/...` is broken everywhere
// but the machine that generated it.
//
// The cost is that the script must sit one level under the repo (`runs/<id>.sh` — where `make
// repro` puts it), so `../scripts/` reaches the library. REPRO_LIB=<path> overrides that for a
// script kept elsewhere, and an unfound library says so instead of failing later as a pile of
// "command not found" from every function the script calls.
const LIB_SOURCE_LINES = [
  'REPRO_LIB="${REPRO_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/repro-lib.sh}"',
  '[ -r "$REPRO_LIB" ] || { echo "repro-lib.sh not found at $REPRO_LIB — keep this script one level'
    + ' under the repo (runs/), or set REPRO_LIB=<path>" >&2; exit 1; }',
  'source "$REPRO_LIB"',
];

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
    ...LIB_SOURCE_LINES,
    "",
    "VERBOSE=${VERBOSE:-0}", // plain string, not a template literal — must reach bash literally
    `BIN=${sq(opts.bin)}`,
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
    // Foregrounding the note in the GUI is presentation, not measurement, and is OPT-IN in the
    // harness (`--open-notes`, default off). Kept in step here so a repro's write path is the
    // same shape as a real rep's by default.
    "OPEN_NOTES=${OPEN_NOTES:-0}",
    "",
  );

  // Sparse, keyed by the actual node NUMBER (like NODE_IP already is) — not a
  // compact 0-based array. A history skipping a node (e.g. only N1 and N3) must not shift N3's
  // entry into slot 1: repro-lib.sh indexes NODES[$1] directly, no position/number translation.
  for (const d of opts.containers) {
    lines.push(`NODES[${d}]=n${d}`, `NODE_IP[${d}]=${nodeIp(`n${d}`)}`);
  }
  lines.push("");

  const allSelectors = opts.containers.map(String);
  if (opts.localBin) allSelectors.push("L");
  lines.push(`ALL_NODES=(${allSelectors.join(" ")})`, "");

  // Before the first op: this script has no preflight, and its waits fail silently, so a paused
  // node would surface as missing tokens in the final Check — indistinguishable from a real loss.
  lines.push("AssertSyncRunning", "");

  let activeNode: number | "local" = 1;
  let anyAppendYet = false;
  const offline = new Set<number>(); // node numbers left disconnected so far
  // DSL letter -> tokens appended to it, in order, each with the node that wrote it. The owner is
  // needed by `W`: the real one ignores tokens stranded on a DISCONNECTED node, since those cannot
  // arrive and requiring them would hang forever (see execute.ts's "wait" case).
  const tokensByLetter = new Map<string, { token: string; owner: number | "local" }[]>();
  let activeNote: string | null = null; // the note cursor a `W` waits on — set by append, like execute.ts
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
      case "wait": {
        // A `W` before any append is a no-op, matching execute.ts (`if (!activeNote) break`).
        if (!activeNote) break;
        // The REAL `W` is token-aware: it waits until every acked token for the ACTIVE NOTE, from
        // every node not currently disconnected, is on this node's disk AND this node reports
        // synced. Polling only sync:status — what this generator used to emit — is the OLD `W`,
        // and it returns instantly on a node that has not written anything itself, which is the
        // exact defect the redesign removed. A repro that waits differently races differently.
        const expected = (tokensByLetter.get(activeNote) ?? [])
          .filter((t) => t.owner === "local" || !offline.has(t.owner))
          .map((t) => t.token);
        // `W<n>` carries its own patience; bare `W` uses WAIT_CAP_SEC (see the header note on how
        // that differs from the real bare `W`, which waits indefinitely).
        const cap = op.seconds ?? waitCapSec;
        const args = [`WaitFor ${sel(activeNode)} ${activeNote} ${cap}`, ...expected.map(sq)].join(" ");
        lines.push(args, "");
        break;
      }
      case "append": {
        anyAppendYet = true;
        const letter = op.note!;
        activeNote = letter;
        lines.push(`Append ${sel(activeNode)} ${letter}`, "");
        seq++;
        const id = activeNode === "local" ? (opts.localNodeId ?? "local") : `n${activeNode}`;
        const token = formatToken({ node: id, seq, note: letter });
        const list = tokensByLetter.get(letter);
        if (list) list.push({ token, owner: activeNode }); else tokensByLetter.set(letter, [{ token, owner: activeNode }]);
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
    for (const [letter, tokens] of tokensByLetter) lines.push(`Check ${letter} ${tokens.map((t) => sq(t.token)).join(" ")}`, "");
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

  let history: History;
  try {
    history = parse(values.history);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  // The history's own content determines which containers/local instance it needs — see dsl.ts's
  // requiredNodes (matches run.ts's own --history behavior; no separate --nodes flag to keep in
  // sync with it). localBin gets a sane default like --bin already has, rather than being hard-
  // required — only actually used below if the history uses L.
  const req = requiredNodes(normalize(history));
  const localBin = values["local-bin"] ?? DEFAULT_LOCAL_BIN;
  // Only worth a subprocess call when the local instance is actually requested — mirrors run.ts's
  // own hostname auto-detect (same caveat: a guess, not verified to match what Sync itself calls it).
  const localNodeId = req.local ? (values["local-node-id"] ?? (await runProcess("hostname", [])).stdout.trim()) : undefined;

  // Resolved here (not left to generateScript's own default) so the same value can also name
  // the default output file below. Mirrors generateScript's own default exactly (the normalized
  // history string) — cheap and pure to recompute, not worth changing generateScript's return
  // type just to avoid one extra normalize/serialize call.
  const runId = values["run-id"] ?? serialize(normalize(history));

  let script: string;
  try {
    script = generateScript(history, {
      containers: req.containers,
      bin: values.bin ?? "/opt/obsidian/obsidian-cli",
      network: values.network ?? "obsidian-net",
      localBin: req.local ? localBin : undefined,
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
