# Obsidian Sync Tester

A TypeScript test harness that hunts for **data loss in Obsidian Sync** when the
same notes are edited on multiple devices, simulated in containers. Kind of a poor-man's semantic fuzzer for a distributed system.

Inspired by the amazing [Jepsen](https://jepsen.io/), which was far too much for this case.

## Attribution

The code is 100% Claude's. In fact, I barely know TypeScript; I just hope that the Obsidian devs will be more receptive to TS.

However, while writing all that code, Claude also tried making all the mistakes a beginner would have, and then some. So the design / functional spec and docs are 100% mine, based on the lessons learnt while building [DARUM](https://hmijailblog.blogspot.com/2025/04/Introducing-DARUM-DAfny-Resource-Usage-Measurement.html), which (in its own way) also plays with randomness to make a black box reveal a bit of its inner workings.

Blog post with details and lessons learned coming soon.

## General usage

`make help` lists every command. Make is the easy entry point, which maps to other tools as needed.

Common flow:

```sh
make install && make check        # install (npm ci) + typecheck + unit tests

# Create two node containers:
make build && make login
# Connect through VNC to the container (localhost:5900). A pristine Obsidian is waiting. Configure it to Sync to a vault and "create conflict file". Enable the Obsidian CLI.
make capture                      # extracts the login credentials into ./secrets (git-ignored)
make containers-up                # launch n1 + n2 fresh with the captured credentials
make clean-data                   # OPTIONAL clean slate: empty the vault + wipe runs/

make run HISTORY=N1AaWN2Aa REPEAT=3      # run one specific history
make soak HISTORY=N1AaWN2Aa              # soak one history until Ctrl-C
make soak TURNS=paced                    # generate histories and run them until Ctrl-C
make analyze                             # aggregate runs/ into a report

make repro HISTORY=N1DAaWN2AaC           # write a standalone bash script reproducing that history by hand
```

`make repro` bypasses the harness's own execution engine entirely — it writes an executable plain
bash script to `runs/<history>.sh` (named after the history itself, e.g. `runs/N1DAaWN2AaC.sh`;
`OUT=<path>` to write elsewhere instead, `OUT=-` to print to stdout instead of writing a file) for
manually poking at one specific finding. The history
translates into a short, flat sequence of calls to a handful of functions (`Disconnect 1`, `Append 1 a`,
`Wait 1`, ...) defined once in `scripts/repro-lib.sh` (a small hand-maintained bash library every
generated script sources) — deliberately simplistic: one-shot commands, no retries, no per-note
settle/quiet-window logic (that's `execute.ts`'s job). The generated script always ends by reconnecting
any node left disconnected, waiting for everyone to settle, then `Check`ing every appended token against
every node's (and the Mac's) canonical content and conflict files, printing `OK`/`MISSING` per token — the
same "did it survive somewhere" rule as the real oracle, just without its settle-timing machinery. A
step that genuinely fails (a create that didn't report success, a podman network call that exits
non-zero) aborts the whole script immediately with a clear `ABORT: ...` message rather than
cascading into confusing follow-on errors — a `Wait` that simply times out is the one exception,
since that's often the finding itself, not a broken step. Set `VERBOSE=1` when invoking the
generated script (e.g. `VERBOSE=1 runs/N1Aa.sh`) to echo every real command to stderr. Notes are
named `bughunt/<ts>-<letter>-<run-id>`, matching real reps' own convention — the timestamp is
generated fresh each time the *script* runs (not at generation time), so re-running the same
script twice never collides with the first run's notes. Takes `RUN_ID`/`WAIT_CAP_SEC`/
`WAIT_POLL_SEC`/`OUT` in addition to the usual `NODES`/`NETWORK`/`OBSIDIAN_BIN`/`MAC_BIN`/
`MAC_NODE_ID`; `make repro HISTORY=...` needs no containers up (it never touches podman itself).

Each repeat generates one result file, `runs/<ts>-<history>/<repTs>.jsonl`. It contains the timestamped execution
trace, opening with a `history` event (the DSL string + parsed ops, every configured node's own id —
`nodes`, so a rep that never happens to select every configured node still records what was actually
live during it — the isolator/settle-timing config that governed the run, and the Obsidian version(s)
involved — including `macObsidianVersion` when a Mac node is configured, which can differ from the
containers' pinned build) and closing with a
`results` event (the verdict), or `obsfail`/`unknown`. A failing repeat's file is renamed with its outcome suffix
(`<repTs>-LOST.jsonl`, etc.). The group dir's `<ts>` is when that
history started executing.

Timestamps are `DD**T**HHMMSS` for easier eyeballing. A `-2` is appended on the rare same-second collision within a dir.

The notes that are created by a run creates in Obsidian are named `bughunt/<repTs>-<letter>-<history>`, e.g.
`bughunt/26T181530-a-N1AaN2WAa.md`. `<repTs>` is the repeat's timestamp (keeps each
repeat's notes distinct and easy to refer to), the trailing `-<history>` is the DSL string, and `-<letter>`
is the DSL note letter the concrete note maps to (the `x` in `Ax`), so a multi-note
history (`NOTES>1`) yields `…-a-…`, `…-b-…`, … side by side.

**Vault safety:** every note the harness creates lives under the `bughunt/` folder, and
`clean-notes`/`clean-data` only ever delete *inside* `bughunt/`. So even if pointed at a
real, in-use vault, the tester should keep your own notes safe.

**Better make backups, though.**


## Parameters

- Use in make as `VAR=value`: `make soak TURNS=paced`. Make maps them to the flags below and prints the resulting CLI line.
- Use directly in npm: `npm run start -- --turns paced`.

`src/run.ts` holds the defaults.

| make var | CLI flag | default | meaning |
|---|---|---|---|
| `HISTORY` | `--history` | *(generate)* | run a specific DSL string instead of generating |
| `STEPS` | `--steps` | — | with `HISTORY`: run only its first N **ops** (a prefix — for shrinking a finding one step at a time) |
| `REPEAT` | `--repeat` | 10 | repeats per history |
| `HISTORIES` | `--histories` | 1 | number of histories to run (≤0 = until killed) |
| `DURATION_MIN` | `--duration-min` | — | run for N minutes instead of a count — **checked only between histories** |
| `SCENARIO` | `--scenario` | `random` | `random` (generator) or `stale` (disconnect-pile-reconnect preset) |
| `OPS` | `--ops` | `6-12` | edit-count range — counts **`A` only**; collapse may leave fewer. A single number (`9`) fixes the count (same as `9-9`) |
| `NOTES` | `--notes` | 1 | distinct notes per history (1 = max contention) |
| `TURNS` | `--turns` | `barrier` | cross-node coordination: `barrier` / `paced` / `concurrent` |
| `PAUSE_PROB` | `--pause-prob` | 0 | chance of a ~10s pause after an edit |
| `PARTITION_PROB` | `--partition-prob` | 0 | chance per edit of a `D`…`C` partition (needs 2+ nodes) |
| `ISOLATOR` | `--isolator` | `network` | `network` (partition) or `sync` (cooperative baseline) |
| `NODES` / `NETWORK` / `OBSIDIAN_BIN` | `--nodes` / `--network` / `--bin` | `n1,n2` / `obsidian-net` / `/opt/…` | container plumbing |
| `MAC_BIN` | `--mac-bin` | `.../Obsidian.app/Contents/MacOS/obsidian-cli` | path to a local `obsidian-cli` binary (NOT the GUI `Obsidian` binary — the CLI is much faster per-call) — enables the DSL's `M` node (see the DSL table above); clear it (`MAC_BIN=`) for no Mac participation. A history containing `M` with no `MAC_BIN`/`--mac-bin` fails fast at startup rather than crashing mid-run |
| `MAC_NODE_ID` | `--mac-node-id` | OS `hostname` | the Mac's own Sync-reported device name, used to attribute its conflict files correctly — `hostname` is a guess, not verified to match; override if a real conflict shows a mismatch |
| `SKIP_HOST_CHECK` | `--skip-host-check` | off | skip the host-online checks: the startup preflight *and* the in-settle host-outage wait (set it where outbound TCP is blocked, else a stalled settle would wait forever) |
| `POLL_SEC` | `--poll-sec` | 1 | how often (s) to re-read every node's state while waiting |
| `MIN_FLOOR_SEC` | `--min-floor-sec` | 3 | observe at least this long before declaring done — catches a sync slow to *start* right after a reconnect |
| `CAP_SEC` | `--cap-sec` | 120 | hard ceiling on any single wait; exceeding it is a `-TIMEOUT` (inconclusive) |
| `W_SETTLE_SEC` | `--w-settle-sec` | 4 | for the `W` command: how long the `synced` state must hold |
| `FINAL_SETTLE_SEC` | `--final-settle-sec` | 15 | end-of-history settle window; needs to cover a potential round-trip sync |
| `PROBE_SEC` | `--probe-sec` | 5 | per-call cap on the settle's `sync:status` probe — it blocks until synced, so this bounds it into a pollable "synced yet?" (a timeout reads as *still syncing*) |
| `RUNS_PREFIX` | `--runs-prefix` | *(cwd)* | parent dir for the whole `runs/` tree, so a soak's artifacts (logs, rep `.jsonl` files, `analysis.md`) can live somewhere other than the working directory |
| `SKIP_SNAPSHOT_TIMING` | `--skip-snapshot-timing` | off | omit the pause-snapshot's per-call `ms` fields (a debug aid for diagnosing a slow snapshot, on by default) |

# How it all works

## Generating sequences of edits with a tiny DSL

A test is a **history**: a string of user actions replayed against
containerized nodes. Commands are uppercase, parameters lowercase/digits.

| Command | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `M` | set the active node to the Mac — a real local Obsidian instance, if `MAC_BIN` is configured (see Parameters); **exempt from `D`/`C`** below, it must always stay connected. Its Sync state is checked before every op it performs — if found `paused`/`error`/`stopped`/`offline`, the whole run aborts (not just that rep), since a disconnected Mac invalidates every subsequent rep until fixed |
| `A<x>` | append a uniquely-tagged line to note `x` (`Aa`), by the active node (first touch creates it; also opens it in the GUI so you can watch the history unfold) |
| `D` / `C` | disconnect / connect the active node from the network |
| `W`    | wait until the active node reports that the last-edited note is synced |
| `P<n>` | pause ~`n` seconds (default 10) |

Example: `N1AaWN2Aa` → node 1 appends to note `a`, waits for sync; node 2
appends to the same note.

Histories can be auto-generated or typed manually. They are run through a `normalize` pass so that histories that would be very similar in practice also look similar as a string:
- For clarity, a pause not adjacent to an action (`D`/`C`/`A`) floats forward to the next action (`N1PN2AaAa` → `N1N2PAaAa`)
- Redundant node selections vanish (`N1N2PAaAa` → `N2PAaAa`)
- Adjacent appends to the same note collapse into a single append. (`N2PAaAa` → `N2PAa`)

Timings are necessarily variable between repetitions of a history, since we don't have control of the Sync server, timing of the client's retries, network state, etc. This can cause results to change every time you repeat the history. Therefore histories are run `REPEAT` times to sample the distribution of end results. Also, to minimize variability in a given history, command W waits until Obsidian itself reports the node is synced.

Note that the harness models a single user using Obsidian across `NODES` devices (plus the Mac, when configured), so there's a single thread of control doing everything. This means that e.g. a Pause command applies across all nodes at once: the control thread does nothing, while Obsidian might be doing its thing. Similarly, W waits for the current node to report it's synced, but this also implies that the other nodes wait until that happens.

At the end of the history, the harness reconnects all nodes to the network,  waits for them all to report synced, and still waits for a settling window to ensure that no further changes happen. Only then the end result is judged.

Edits are append-only for now, since that is a case supported by the CLI, and the bug reports in the forum hint that this should be enough to cause trouble.

### A practical example

Here's is a simple history string that already surfaces an Obsidian Sync bug in Obsidian 1.12.7: **N2DN1AaWN2AaCW**

- N2: selects N2 as the current node
- D : disconnects the current node. (See below for different ways of disconnecting: disable network, disable sync)
- N1: selects N1 as the current node
- Aa: appends a token to note "a" in node 1 (this is a "logical name"; see below for actual naming of notes)
- W : wait until the current note in the current node is reported as synced by Obsidian
- N2: selects N2
- Aa: appends a new token to note "a" in node 2 (same "logical note" as before)
- C : connect the current node
- W : wait for sync

Interestingly, this results in data loss only with `ISOLATOR=network`, not `ISOLATOR=sync`.


### Pacing between cross-node edits to the same note

A history can edit the same note in different nodes. This can be done conservatively (waiting for Obsidian to report it is synced) or aggressively (like typing into that note at your desktop and immediately typing into that same note on your phone). This is controlled via **`TURNS`**:

- **`barrier`** (default) : there is a `W` before each cross-node edit. As far as the user can see, the node is synced.
- **`paced`** : a `P`ause command (default 10s) happens before each cross-node edit. This might or might not be enough for the sync to settle.
- **`concurrent`** : cross-node edits can happen immediately.

### Exercising sync recovery after disconnections

The main expected source of bugs is synchronization across nodes, particularly when the nodes get disconnected and reconnected to the network while the notes change.

`PARTITION_PROB` defines the probability of 'D'/'C' appearing in the history, causing a node going offline / online again.

The exact way in which nodes go offline is selected via `ISOLATOR`:

- `network`: Default. Detach/attach the container from/to a Podman network. Each of the `D`/`C` commands block until a TCP probe to a numeric address confirms the network is actually dis/connected, to avoid the possibility of Sync squeezing through. Fixed IP and MAC are used to minimize the network disruption. (Ping is not used because of complexities of rootless container vs ICMP access.)
- `sync`: Obsidian-cli `sync off` / `sync on` commands.

`SCENARIO=stale` is a separate, more fixed mode: one node disconnects early and stays offline for a long (30s) window while the
other node(s) keep editing the same note, then the stale node reconnects at the end. It mirrors the bug report of a device that connects after a long time offline and somehow causes a flood of conflicts .

## Outcomes

Results of a run are recorded in a directory named after the start timestamp and the history: "DD**T**HHMMSS-HISTORY". If any of the history repetitions ended up in a non-OK state, the directory name has a suffix `-BAD<pct>` indicating the % of repetitions that ended badly.

The result of each repetition of the history is recorded in a JSONL file under the history's directory, with the rep start timestamp. This file contains the history execution details: any config parameters, the execution trace and end result. If the repetition ended in a not-OK state, its name gets a suffix:

| suffix | meaning |
|---|---|
| *(none)* | PASS |
| `-LOST` | a token was writen but is gone |
| `-DUPL` | a token is duplicated (nodes still converged) |
| `-SYNCBAD` | nodes synced and settled but disagree |
| `-NOUPLOAD` | a token was writen in a node but never reached the server |
| `-TIMEOUT` | some node never finished syncing within the allowed time |
| `-OBSFAIL` | obsidian-cli reports something but the filesystem disagrees |
| `-UNKNOWN` | some situation couldn't be recognised |


OBSFAIL and UNKNOWN mean that something is seriously wrong and needs special handling, so they are additionally logged to runs/OBSFAIL.log and runs/UNKNOWN.log, with data to reproduce the error.

`make analyze` aggregates all the runs' information into tables in `runs/analysis.md`, to ease eyeballing of failure patterns across many repetitions.

### Judging whether there was a bug: token survival

Each command `Ax` appends a unique token `(<node>-<seq>-<note>)` to the
note `x`. At the end of the history, the oracle (`src/oracle.ts`) checks that those tokens exist, either in the notes created during that history, or in any corresponding "Conflicted copy". It can detect 3 types of problems:

- **loss** : a token was introduced but at the end of the history it's been lost;
- **duplication** : a token repeated within a file;
- **divergence** : nodes disagree on final content or conflict-file set.

An appended token is read back locally; a write that doesn't read back is retried.


Nodes run with Obsidian Sync in **"create conflict file"** mode. A present conflict file is checked for
a well-formed `(Conflicted copy <device> <ts>)` name attributable to a node.

## Layout

```
src/
  dsl.ts         the history DSL: parse / serialize           (dsl.test.ts)
  generator.ts   random history generation                   (generator.test.ts)
  execute.ts     run one DSL history against the nodes, then judge
  oracle.ts      token-survival / convergence verdict         (oracle.test.ts)
  driver.ts      Obsidian CLI wrapper                         (driver.test.ts)
  cli-parse.ts   positively-recognized-output-only CLI parsers (cli-parse.test.ts; see docs/cli-trust.md)
  alarm.ts       classify + log a correctness-assumption violation (-OBSFAIL/-UNKNOWN) (alarm.test.ts)
  exec.ts        Local / Podman executors
  isolate.ts     fault primitives (network partition / sync toggle)
  net.ts         host-internet connectivity probe (tells a Sync stall apart from a host outage)
  types.ts       shared types (NodeId, ExecResult, token format, NOTE_DIR)
  history.ts     per-rep JSONL trace (one file, opens with `history`, closes with `results`)
  runner.ts      single divergence-round (used by run-local)
  run.ts         containerized entrypoint   (npm run start)
  run-local.ts   single-node pipeline check (npm run local)
  analyze.ts     offline soak aggregator    (npm run analyze)
  clean-notes.ts delete the harness's notes (bughunt/) on all nodes (npm run clean-notes)
  smoke.ts       driver probe               (npm run smoke)
containers/      Dockerfile + entrypoint (Obsidian under Xvfb)
docs/
  cli-trust.md   why/how the harness never judges from CLI output it didn't positively recognize
Makefile         podman lifecycle: build -> login -> capture -> containers-up -> run
```



## Future work

- Obsidian Sync's auto-merge mode is not tested yet. Conflict file mode is the official recommendation in the Obsidian forums thread about data loss, so I thought I'd start here.
- Outcome judgment is very lenient: as long as the input tokens are stored *somewhere* (canonical note or conflict file), the result is considered OK. However, a real user surely wouldn't be happy if their inputs keep getting moved into conflict files randomly. So judgment should probably be made more... judgmental.
- Both auto-merge and stricter judgment of conflict files would probably require keeping an internal model of what results are acceptable according to Obsidian Sync docs. That would probably be a bit of a can of worms, given the closed-source nature of the beast.
- Relatedly, I started this project inspired by Jepsen, which probably does something similar. turned out to be overkill for something like Obsidian. Plus, there is a lot of research on fuzzing a black box with semantics, surely including internal models too. Something to look into, I guess.
- It would be interesting to force network failures or slowness, once Sync is solid enough over a normal network.
- Stopping Sync from working via network vs via obsidian-cli commands changes the behavior (and the bugs found). What if we also fully restarted Obsidian as a history command? (as it can happen in e.g. iOS because of memory pressure)
- The Obsidian Sync driving code could be made generic to work on other sync backends. Would e.g. Obsidian-on-iCloud lose more or less data? What about Syncthing, etc?
- In fact, the very Obsidian driving could be made generic to work on other programs, like Logseq. That'd be kinda funny, given that I left Logseq because of how *lossy* it was.
- The Mac node (`M`) currently works on the (assumed Mac) host's Obsidian instance, which limits what can be done with it: e.g., no network faults. It could be interesting to use `tart` to have a macOS VM and treat it as another container — provisioning it might be simpler than it sounds: an Obsidian developer's own forum comment says Sync credentials live in IndexedDB inside the app's appdata folder (not the OS Keychain), so copying that folder into a fresh VM may carry the login over, similar to how the container image already bakes one in.
- A nearer-term alternative for real network isolation without a VM: a narrowly-scoped `pfctl` anchor blocking only Obsidian Sync's own traffic (not a broad default-deny), paired with a session-scoped sudoers grant set up/torn down per soak (`make pf-setup`/`make pf-teardown`, restricted to exact `pfctl` args) and an exit hook to flush it on any normal exit. Would reverse the current "Mac always connected" premise, so it needs its own design pass.


## Tooling

Node is pinned in `.nvmrc`, enforced by `engines` + `engine-strict`; use `npm ci`
for lockfile-exact installs.

Obsidian is driven through its CLI, hoping that it behaves just like it would when driven through the GUI.

Podman on macOS. Built the images with a view to be easy to run in AWS-EC2, but didn't try.

Developed using Claude Code, with Claude Opus 4.8 and Claude Sonnet 5, on a Claude Pro Claude subscription and no extra Claude credits.