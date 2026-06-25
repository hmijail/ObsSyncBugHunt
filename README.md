# Obsidian Sync Tester

A small TypeScript harness that hunts for **data loss in Obsidian Sync** when the
same note is edited on multiple devices. Every edit goes through the **Obsidian CLI**, so Sync hopefully works as it would for a human.

## Generating sequences of edits with a tiny DSL

A test is a **history** — a string of user actions replayed against
containerized nodes. Commands are uppercase, parameters lowercase/digits. An
**active node** and **active note** are cursors that persist until changed.

| Command | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `E<x>` | select the active note (`Ea`); also opens it in the GUI |
| `A`    | append a uniquely-tagged line to the active note, by the active node |
| `D` / `C` | disconnect / connect the active node from the network |
| `W`    | wait until the active node reports that the active note is synced |
| `P<n>` | pause ~`n` seconds (default 10) |

Example: `N1EaAWN2A` → node 1 selects note `a`, appends, waits for sync; node 2
appends to the same note.

At the end of the history, the harness waits for all nodes to report synced (reconnecting them to the network if necessary).
The thing varying across repeats is timing, as it depends on how fast the Obsidian CLI processes commands. Most importantly, Obsidian Sync itself will take its time, and the simulated user might wait for it to finish (command `W`).

Edits are append-only for now, since that is a case supported by the CLI, and the bug reports in the forum seem to hint that this should be enough to cause trouble.

A history can be hand-written (`HISTORY=N1EaAWN2A`) or generated (see below), and
each is **repeated** `REPEAT` times (default 10) to cope with Sync's nondeterminism.

## Judging whether there was a bug: token survival

Each command `A` appends a unique token `[op-<node>-<seq>]` to the
note. At the end of the history, the oracle (`src/oracle.ts`) checks that those tokens exist, either in the notes created during that history, or in any corresponding "Conflicted copy". It can detect 3 types of problems:

- **loss** — a token was introduced but at the end of the history it's been lost;
- **duplication** — a token repeated within a file;
- **divergence** — nodes disagree on final content or conflict-file set.

> The token is bracketed so one can't be a substring of another (`[op-n1-1]` vs
> `[op-n1-10]`); matching is also boundary-aware. An edit is only *acknowledged*
> after its token is read back locally — because **`obsidian-cli` always exits 0**
> (a known upstream bug), success is judged by content, never by the exit code.

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
| `-DIFF` | nodes disagree after settling |
| `-UNSYNCED` | a note never reached the server (`sync:history total < 1`) |
| `-TIMEOUT` | never reached quiescence — inconclusive |

A history directory is suffixed `-BAD<pct>` with the percentage of non-OK repeats,
so a soak is eyeball-scannable for where to dig. `npm run analyze` aggregates it all.

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
  clean-notes.ts empty the vault on all nodes (npm run clean-notes)
  smoke.ts       driver probe               (npm run smoke)
containers/      Dockerfile + entrypoint (Obsidian under Xvfb)
Makefile         podman lifecycle: build -> login -> capture -> up -> run
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

make run HISTORY=N1EaAWN2A REPEAT=3      # one specific history
make soak TURNS=paced                    # generate + run until Ctrl-C (overnight)
make analyze                             # aggregate runs/ into a report
```

Per-run artifacts live in `runs/<history>/<epoch6>/`: `history.json` (the intended
ops), `history.jsonl` (the timestamped execution trace, incl. `content-at-wait`
snapshots), `results.json` (the verdict), and `meta.json`.

## Parameters

All set via environment variables (`src/run.ts` holds the authoritative list):

| env | default | meaning |
|---|---|---|
| `HISTORY` | *(generate)* | run a specific DSL string instead of generating |
| `REPEAT` | 10 | repeats per history |
| `HISTORIES` | 1 | number of histories to run (≤0 = until killed) |
| `DURATION_MIN` | — | run for N minutes instead of a count — **checked only between histories**, so it finishes the current history's `REPEAT` reps first |
| `SCENARIO` | `random` | `random` (generator) or `stale` (disconnect-pile-reconnect preset) |
| `OPS` | `6-12` | edit-count range — counts **`A` only**; collapse may leave fewer in the string |
| `NOTES` | 1 | distinct notes per history (1 = max contention) |
| `TURNS` | `barrier` | cross-node coordination: `barrier` / `paced` / `concurrent` |
| `PAUSE_PROB` | 0 | chance of a ~10s pause after an edit |
| `PARTITION_PROB` | 0 | chance per edit of a `D`…`C` network partition (needs 2+ nodes) |
| `ISOLATOR` | `network` | `network` (partition) or `sync` (cooperative baseline) |
| `NODES` / `NETWORK` / `OBSIDIAN_BIN` | `n1,n2` / `obsidian-net` / `/opt/…` | container plumbing |
| `POLL_SEC` / `MIN_FLOOR_SEC` / `CAP_SEC` / `W_SETTLE_SEC` / `FINAL_SETTLE_SEC` | 1 / 3 / 120 / 4 / 6 | sync-wait tuning (seconds) |

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
