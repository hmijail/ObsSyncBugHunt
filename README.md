# Obsidian Sync Tester

A small TypeScript harness that hunts for **data loss in Obsidian Sync** when the
same note is edited on two devices. Every edit goes through the **Obsidian CLI**
(no direct file writes), so Sync engages exactly as it would for a human.

## Histories: a tiny DSL

A test is a **history** — a string of user actions replayed against two
containerized nodes. Commands are uppercase, parameters lowercase/digits. An
**active node** and **active note** are cursors that persist until changed.

| token | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `E<x>` | select the active note (`Ea`); also opens it in the GUI |
| `A`    | append a uniquely-tagged line to the active note, by the active node |
| `D` / `C` | disconnect / connect the active node from the network |
| `W`    | wait until the active note is synced & settled |
| `P<n>` | pause ~`n` seconds (default 10) |

Example: `N1EaAWN2A` → node 1 selects note `a`, appends, waits for sync; node 2
appends to the same note. **Trailing waits are implicit** — the executor always
reconnects everyone and settles before judging, so a string needn't end in `W`.
Timing comes *only* from explicit `W`/`P`, so the one thing varying across repeats
is Sync itself. The user never "syncs" — they only edit, wait, and hope. Edits are
append-only for now (`M`, same-line modify, is a deliberately deferred harsher lever).

A history can be hand-written (`HISTORY=N1EaAWN2A`) or generated (see below), and
each is **repeated** `REPEAT` times (default 10) to cope with Sync's nondeterminism.

## The oracle: token survival

Each `A` embeds a unique, **self-delimiting** token `[op-<node>-<seq>]` into the
note. After sync settles, the oracle (`src/oracle.ts`, unit-tested) verifies — by
exact match across `canonical ∪ (Conflicted copy …)` files — three invariants, with
no model of the "expected" merged text:

- **loss** — an acknowledged token present nowhere → data loss;
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

`generateHistory` emits random histories in the DSL vocabulary:

- **benign** (default) inserts a `W` before every cross-node edit, so edits never
  overlap (append-contention after propagation);
- **concurrent** (`CONCURRENT=1`) omits the wait (maybe create-create, maybe contention);
- the **stale** preset (`SCENARIO=stale`) disconnects a node early, piles edits, then heals.

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
make up                           # launch n1 + n2 fresh
make clean-notes                  # empty the vault for a clean baseline

make run HISTORY=N1EaAWN2A REPEAT=3      # one specific history
make soak                                # generate + run until Ctrl-C (overnight)
make analyze                             # aggregate runs/ into a report
```

Per-run artifacts live in `runs/<history>/<epoch6>/`: `history.json` (the intended
ops), `history.jsonl` (the timestamped execution trace, incl. `content-at-wait`
snapshots), `results.json` (the verdict), and `meta.json`.

## Future work

Schedule-aware **conflict expectation**: from the offline trace, a node that made
disconnected edits while another synced *should* yield a conflict file — flagging a
missing one needs reasoning over the schedule, not just the end state. Worth a look
as prior art / lit review (verify before relying on any of these): Jepsen's
consistency-testing methodology (the project's namesake), CRDT / operational-
transformation theory, and academic studies of file-sync conflict handling.

## Tooling

Node is pinned in `.nvmrc`, enforced by `engines` + `engine-strict`; use `npm ci`
for lockfile-exact installs.
