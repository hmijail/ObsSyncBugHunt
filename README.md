# Obsidian Sync Tester

A small TypeScript harness that hunts for **data loss in Obsidian Sync** when the
same note is edited on multiple devices. Every edit goes through the **Obsidian CLI**, so Sync hopefully works as it would for a human.

## Generating sequences of edits with a tiny DSL

A test is a **history** — a string of user actions replayed against
containerized nodes. Commands are uppercase, parameters lowercase/digits. The
**active node** is a cursor that persists until changed; each append names its own note.

| Command | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `A<x>` | append a uniquely-tagged line to note `x` (`Aa`), by the active node (first touch creates it; also opens it in the GUI) |
| `D` / `C` | disconnect / connect the active node from the network |
| `W`    | wait until the active node reports that the last-edited note is synced |
| `P<n>` | pause ~`n` seconds (default 10) |

Example: `N1AaWN2Aa` → node 1 appends to note `a`, waits for sync; node 2
appends to the same note.

Every history (generated or typed) is run through a `normalize` pass first, so the
**printed string is exactly what executes**: a pause not adjacent to an action (`D`/`C`/`A`)
floats forward to the next action (`N1PN2Aa` → `N2PAa`), redundant node-sets vanish, and
adjacent same-note appends collapse.

At the end of the history, the harness waits for all nodes to report synced (reconnecting them to the network if necessary).
The thing varying across repeats is timing, as it depends on how fast the Obsidian CLI processes commands. Most importantly, Obsidian Sync itself will take its time, and the simulated user might wait for it to finish (command `W`).

**Execution model (and its limits).** A history runs **strictly sequentially** — one
awaited op loop — so any `P`/`W`/`D`/`C` blocks the *whole* harness from issuing the
next command (background Sync keeps running during a pause; only new *edits* are
serialized). This is deliberate: it models one human moving between their own devices,
not two devices typing into the same note at the same instant. The bug we're after —
logically-concurrent edits on a shared base — still arises, just not from wall-clock
simultaneity: a partition (`D … C`) has both sides edit the same base unaware of each
other, and `concurrent` turns race edits against the live sync window. True
sub-second-simultaneous edits with no partition are out of scope — both rare for a
single user and barely well-defined.

Edits are append-only for now, since that is a case supported by the CLI, and the bug reports in the forum seem to hint that this should be enough to cause trouble.

A history can be hand-written (`HISTORY=N1AaWN2Aa`) or generated (see below), and
each is **repeated** `REPEAT` times (default 10) to cope with Sync's nondeterminism.

## Judging whether there was a bug: token survival

Each command `A` appends a unique token `(<node>-<seq>-<note>)` to the
note. At the end of the history, the oracle (`src/oracle.ts`) checks that those tokens exist, either in the notes created during that history, or in any corresponding "Conflicted copy". It can detect 3 types of problems:

- **loss** — a token was introduced but at the end of the history it's been lost;
- **duplication** — a token repeated within a file;
- **divergence** — nodes disagree on final content or conflict-file set.

> The token is parenthesized so one can't be a substring of another (`(n1-1-a)` vs
> `(n1-10-a)`); matching is also boundary-aware. Parens (not `[ ]`/`[[ ]]`, which
> read as a checkbox/wikilink in the editor) keep it inert plain text in the GUI. An
> edit is only *acknowledged* after its token is read back locally — because
> **`obsidian-cli` always exits 0** (a known upstream bug), success is judged by
> content, never by the exit code; a write that doesn't read back is retried.

Nodes run in **"create conflict file"** mode. A present conflict file is checked for
a well-formed `(Conflicted copy <device> <ts>)` name attributable to a node (each
node's Sync device name is its hostname, `n1`/`n2`); auto-merge with no conflict
file is a documented-legal outcome, so the oracle does not require one.

## Outcomes

Per repeat (a non-OK repeat's directory is suffixed):

| suffix | meaning |
|---|---|
| *(none)* | PASS |
| `-LOST` | an acknowledged edit is gone |
| `-DUPL` | a token is duplicated (nodes still converged) |
| `-SYNCBAD` | nodes **settled** (all `synced`, state quiet) but disagree — different canonical, or a conflict file only one node holds |
| `-NOUPLOAD` | a note never reached the server (`sync:history total < 1`) |
| `-TIMEOUT` | never even settled within the cap — a node never reached `synced`, or content kept changing; inconclusive (a host-internet outage doesn't count: the settle pauses until the host is back, then resumes) |
| `-OBSFAIL` | a client **misreports its own vault** — obsidian-cli's `files` listing contradicts a direct `ls` of the vault, or its own `read` (a note reads as present but is missing from `files`). A real finding, not a Sync convergence issue. Logged to `runs/OBSFAIL.log` with the offending CLI line + throw site |
| `-UNKNOWN` | couldn't judge — obsidian-cli returned output no recognizer matched (a format change → update the parser), or the CLI never answered within the retry budget. Logged to `runs/UNKNOWN.log` with the copy-paste CLI line + throw site |

A history directory is suffixed `-BAD<pct>` with the percentage of non-OK repeats,
so a soak is eyeball-scannable for where to dig. `npm run analyze` aggregates it all into
`runs/analysis.md`: per history string, a markdown table of every rep's whole final state
(every touched note, plus any conflict file, as `(node-seq-note)` tokens), grouped first by
outcome (`PASS`/`LOST`/`DUPL`/...) so a recurring shape is visible at a glance — non-`PASS`
tables also list which reps (by dir name) produced each shape. Never merged across different
histories (note letters/tokens from unrelated DSL structures aren't comparable).

## Faults

A node must be **running but unable to sync** to diverge. Two primitives, via
`ISOLATOR`:

- `network` — detach the container from its Podman network (the bug hunt, default).
  `D`/`C` block until a TCP probe to a numeric address confirms the change, so a
  half-applied partition can't leak an in-flight sync.
- `sync` — Obsidian's own `sync off` / `sync on`; cooperative, the **control baseline**.

## Generation

`generateHistory` builds random histories. Cross-node edits to the same note are
coordinated by **`TURNS`** — a spectrum of synchronization strength:

- **`barrier`** (default) — a `W` before each cross-node edit: strict turns, edits
  never overlap (append-contention on a propagated base);
- **`paced`** — a `P` (~10s) instead of the wait: edits *sometimes* race the sync window;
- **`concurrent`** — nothing: maximum overlap.

**`PARTITION_PROB`** independently injects network partitions: a node — or several, up
to all — goes offline, edits diverge across the gap, then it heals (the
`SCENARIO=stale` preset is just a biased corner of this). Coordination is suppressed
across a partition (you can't take a turn with a disconnected node), so `TURNS`
governs *online* edits and `PARTITION_PROB` governs *offline* divergence,
independently. Consecutive same-kind ops are collapsed in generated histories — and
consecutive pauses summed — since back-to-back local edits add no contention.

## Layout

```
src/
  dsl.ts         the history DSL: parse / serialize           (dsl.test.ts)
  generator.ts   random history generation                   (generator.test.ts)
  execute.ts     run one DSL history against the nodes, then judge
  oracle.ts      token-survival / convergence verdict         (oracle.test.ts)
  driver.ts      Obsidian CLI wrapper                         (driver.test.ts)
  exec.ts        Local / Podman executors
  isolate.ts     fault primitives (network partition / sync toggle)
  history.ts     per-run JSONL trace + results.json
  runner.ts      single divergence-round (used by run-local)
  run.ts         containerized entrypoint   (npm run start)
  run-local.ts   single-node pipeline check (npm run local)
  analyze.ts     offline soak aggregator    (npm run analyze)
  clean-notes.ts delete the harness's notes (bughunt/) on all nodes (npm run clean-notes)
  smoke.ts       driver probe               (npm run smoke)
containers/      Dockerfile + entrypoint (Obsidian under Xvfb)
Makefile         podman lifecycle: build -> login -> capture -> containers-up -> run
```

## Running

`make help` lists every command. Common flows:

```sh
make install && make check        # install + typecheck + unit tests

# two-node containers:
make build && make login          # VNC in: enable CLI, link a TEST vault, "create conflict file"
make capture                      # copy the login into ./secrets (git-ignored), not an image
make containers-up                # launch n1 + n2 fresh
make clean-data                   # fresh slate: empty the vault + wipe runs/

make run HISTORY=N1AaWN2Aa REPEAT=3      # one specific history
make soak HISTORY=N1AaWN2Aa              # soak ONE history forever (Ctrl-C); add STEPS=K for a prefix
make soak TURNS=paced                    # generate + run until Ctrl-C (overnight)
make analyze                             # aggregate runs/ into a report
```

Per-run artifacts live in `runs/<ts>-<history>/<repTs>/`: `history.json` (the intended
ops), `history.jsonl` (the timestamped execution trace, incl. `content-at-wait`
snapshots), `results.json` (the verdict), and `meta.json`. The group dir's `<ts>` is
when that history *started*; each repeat is a `<repTs>` subdir.

Timestamps are `DDTHHMMSS` — day-of-month, `T`, then hours/minutes/seconds, local time
(e.g. `26T181530`); a `-2` is appended on the rare same-second collision within a dir.

The notes a run creates are named `bughunt/<repTs>-<letter>-<history>` — e.g.
`bughunt/26T181530-a-N1AaN2WAa.md`. `<repTs>` is the repeat's timestamp (keeps each
repeat's notes distinct), the trailing `-<history>` is the DSL string, and `-<letter>`
is the DSL note letter the concrete note maps to (the `x` in `Ax`), so a multi-note
history (`NOTES>1`) yields `…-a-…`, `…-b-…`, … side by side.

**Vault safety:** every note the harness creates lives under a `bughunt/` folder, and
`clean-notes`/`clean-data` only ever delete *inside* `bughunt/`. So even if pointed at a
real, in-use vault, the tester never creates, edits, or removes your own notes.

## Parameters

Params are **CLI args** (args-only — env vars aren't read). Set them two ways:

- via make as `VAR=value` overrides — `make soak TURNS=paced` (make maps them to the flags
  below and its recipe echo is the full, copy-pasteable `npm run start -- …` command);
- directly — `npm run start -- --turns paced --partition-prob 0.4`.

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
| `SKIP_HOST_CHECK` | `--skip-host-check` | off | skip the host-online checks: the startup preflight *and* the in-settle host-outage wait (set it where outbound TCP is blocked, else a stalled settle would wait forever) |
| `POLL_SEC` | `--poll-sec` | 1 | how often (s) to re-read every node's state while waiting |
| `MIN_FLOOR_SEC` | `--min-floor-sec` | 3 | observe at least this long before declaring done — catches a sync slow to *start* right after a reconnect |
| `CAP_SEC` | `--cap-sec` | 120 | hard ceiling on any single wait; exceeding it is a `-TIMEOUT` (inconclusive) |
| `W_SETTLE_SEC` | `--w-settle-sec` | 4 | mid-history `W`: how long the converged + `synced` state must hold |
| `FINAL_SETTLE_SEC` | `--final-settle-sec` | 15 | end-of-history settle window; longer than `W`'s — `W` only ever needs one node's own view (or, when a peer happens to be online too, one note's worth of cross-node convergence), while the final settle is the one point that judges the *whole* multi-node system across every note, so it needs more margin against a late second-hop sync |
| `PROBE_SEC` | `--probe-sec` | 5 | per-call cap on the settle's `sync:status` probe — it blocks until synced, so this bounds it into a pollable "synced yet?" (a timeout reads as *still syncing*) |
| `RUNS_PREFIX` | `--runs-prefix` | *(cwd)* | parent dir for the whole `runs/` tree, so a soak's artifacts (logs, rep dirs, `analysis.md`) can live somewhere other than the working directory |
| `SKIP_SNAPSHOT_TIMING` | `--skip-snapshot-timing` | off | omit the pause-snapshot's per-call `ms` fields (a debug aid for diagnosing a slow snapshot, on by default) |

## Future work

Schedule-aware **conflict expectation**: from the offline trace, a node that made
disconnected edits while another synced *should* yield a conflict file — flagging a
missing one needs reasoning over the schedule, not just the end state. Worth a look
as prior art / lit review (verify before relying on any of these): Jepsen's
consistency-testing methodology (the project's namesake), CRDT / operational-
transformation theory, and academic studies of file-sync conflict handling.
FIXME XXX

## Tooling

Node is pinned in `.nvmrc`, enforced by `engines` + `engine-strict`; use `npm ci`
for lockfile-exact installs.
