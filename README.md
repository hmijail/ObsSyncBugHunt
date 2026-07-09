# Obsidian Sync Bug Hunter

A TypeScript test harness that hunts for **data loss in Obsidian Sync** when the
same notes are edited alternatively on multiple devices, simulated in containers. Kind of a poor-man's semantic fuzzer for a simple distributed system, whipped up with help from Claude.

Inspired by [Jepsen](https://jepsen.io/), which is overkill for Obsidian Sync.

## How come?

Obsidian is a nice note-taking app. It's closed-source but free. It has a sync service, Obsidian Sync, which is subscription-based. This service has data-losing bugs. A thread in the Obsidian forums has been running for 2 years now gathering complaints, but the devs seem unable to find the problem. They proposed workarounds that fail too.

I lost data to Obsidian Sync and found that thread. I proposed using e.g. Jepsen to find bugs in a systematic way. There was no response.

I was thinking about using Claude Code for some test project, so I asked it to apply Jepsen to Obsidian. Claude jumped to make things happen; unfortunately those were pretty silly things. It quickly became clear that Jepsen is far too serious a tool for this purpose, and that Claude needs its tasks to have much tighter scope.

So I started guiding the design, following the themes from [DARUM](https://hmijailblog.blogspot.com/2025/04/Introducing-DARUM-DAfny-Resource-Usage-Measurement.html), which (in its own way) also plays with randomness and repetitions to force a black box to reveal a bit of its inner workings. Plus containers and network control.

**So 100% of the design is mine** (and 98% of this README), but **the code is 100% Claude's**. In fact, I don't know much TypeScript; I chose it because it's a language used in the Obsidian ecosystem... and to force myself to stay hands-off and trust Claude.

It works: the harness finds different sequences of operations that trigger sync bugs in Obsidian. (I had plans to make the sequence generator more interesting, but it already finds enough Obsidian Sync bugs as it is.)

And yet, it's hard to imagine developing much serious stuff in this way. Keeping Claude Code (Opus 4.8 / Sonnet 5) in a leash tight enough to stop it from doing silly stuff is consuming in multiple ways. It's like an intern that knows far too much for their own good, uses that knowledge to make bad choices... plus periodically forgets important points... but never, ever lets go of pointless minutiae.

Worse, what did *I* learn from this project? Only things about Claude itself, stuff that might change tomorrow. But nothing about the matter at hand. In fact, it's the opposite: I had to teach Claude how to build this. So **if Claude was an intern, I could expect that they learnt something, and if this was a work project maybe even that they'd take over and keep the project moving forward. But Claude doesn't learn.**

The result is code that is expected to only be read by an LLM, which learnt nothing about why it is like it is. In other words, an **insta-legacy project.**

More detailed blog post coming soon.

## Requirements
* Podman (a podman-machine with 2 vCPUs, 4GB RAM is enough for 2 Obsidian containers)
* Obsidian Sync subscription
* Optionally a local (non-containerized) Obsidian instance.

Bugs that appear between 2 Linux Obsidian instances (in containers) are different to those appearing between e.g. Mac and Linux. So adding a local Mac Obsidian instance can be interesting.

**No LLM is used in the harness. Bugs found aren’t hallucinations.**

## Quick start

The test harness will be creating and editing lots of notes on your Sync vault. It will try to keep the vault safe, by only ever acting on notes inside a folder ("bughunt") in your vault. (In any case you should backup your vault; personally, until bugs are fixed I moved my vault out of Sync and into iCloud Drive)


`make` is the easy entry point to the project, which maps to other tools as needed. `make help` lists every command.

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

make repro HISTORY=N1DAaWN2AaC           # turn that history into a bash script (bug repro with minimal machinery)
```


# How it all works

## A set of Obsidian clients, ready to Sync

When you run `make build`, 2 containers will be built, prepared to run Obsidian. They will be connected to an internal network and to the internet.

Then, `make login` will prepare one of those containers for you to connect through VNC. You will log in to your Obsidian Sync account, connect to a Sync vault, enable creation of conflict files, and enable the Obsidian CLI.

Next, `make capture` will extract from that container your Sync credentials and copy them into the `secrets` directory. This is so that multiple containers can reuse the same credentials, without manually setting up each one of them individually. This information never leaves your computer. **Don't publish that directory; it's already in `.gitignore`.**

And now, `make containers-up` will start your nodes and get them syncing. If there's notes in the vault, they might take some minutes to finish their initial sync. You can connect to each node through VNC, in the port 5900+(node number).

## Generating sequences of Obsidian edits with a tiny DSL

A test is a **history**: a string of user actions replayed against
multiple Obsidian nodes. Commands are uppercase, parameters lowercase/digits.

| Command | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `L` | set the active node to local Obsidian instance |
| `A<x>` | make the active node append a uniquely-tagged line to note `x` (creates it if necessary) |
| `D` / `C` | disconnect / connect the active node from the network (applies to containers, not the Local node)|
| `W`    | wait until the active node reports that the last-edited note is synced |
| `P<n>` | pause ~`n` seconds (default 10) |

Example: `N1AaWN2Aa`= node 1 appends to note `a`, waits for sync; node 2
appends to the same note.

Histories can be auto-generated or typed manually. They are run through a `normalize` pass so that histories that would be very similar in practice also look similar as a string:
- A pause not adjacent to an action (`D`/`C`/`A`) floats forward to the next action (`N1PN2AaAa` → `N1N2PAaAa`)
- Redundant node selections vanish (`N1N2PAaAa` → `N2PAaAa`)
- Contiguous Appends to the same note collapse into a single Append. (`N2PAaAa` → `N2PAa`)

Timings are necessarily variable between repetitions of a history, since we don't have control of the Sync server, timing of the client's retries, network state, etc. This can cause results to change every time you repeat the history. Therefore histories are run `REPEAT` times to sample the distribution of end results. Also, to minimize variability in a given history if desired, command W waits until Obsidian itself reports the node is synced.

Note that the harness models a single user using Obsidian across `NODES` devices, so there's a single thread of control doing everything. This means that e.g. a Pause command applies across all nodes at once: the control thread does nothing, while Obsidian might be doing its thing. Similarly, W waits for the current node to report it is synced, but this also causes the other nodes to wait until that moment.

At the end of the history, the harness reconnects all nodes to the network,  waits for them all to report synced, and still waits for a settling window to ensure that no further changes happen (e.g. generation of conflict files, which later get synced, etc etc). Only then the end result is judged.

Edits to notes are append-only for now, since that is a case supported by the CLI, and the bug reports in the forum hint that this should be enough to cause trouble. Edits also open the note in the nodes' GUI so you can watch the history unfold through a VNC connection.

### Naming of files and notes

Each repetition generates one result file, `runs/<ts>-<history>/<repTs>.jsonl`, which contains the execution trace and metadata, allowing to reconstruct the scenario. A failing repeat's file is renamed with its outcome suffix (`<repTs>-LOST.jsonl`, etc.) Repetitions are grouped under directories named by the timestamp and history.

Timestamps are formatted as DD**T**HHMMSS for ease of eyeballing and of referencing files. This will be helpful when you have tens or hundreds of directories and notes and you need to find which note was created by which repetition.

The notes that are created by a run in Obsidian are named `bughunt/<repTs>-<letter>-<history>`, e.g.
`bughunt/26T181530-a-N1AaN2WAa.md`. `<repTs>` is the repeat's timestamp, the trailing `-<history>` is the DSL string, and `-<letter>`
is the DSL note letter the concrete note maps to. So e.g. a multi-note
history (`NOTES>1`, `HISTORY=AaAb`) generates notes named `…-a-…`, `…-b-…`.

Every note the harness creates lives under the `bughunt/` folder, and
`make clean-notes`/`make clean-data` only ever delete *inside* `bughunt/`. So even if pointed at a
real, in-use vault, the harness should keep your own notes safe. Not recommended, though! **Again: best to make a backup if you do this.**

### Practical example

Here's is a simple history string that already surfaces a very repeatable Obsidian Sync bug in Obsidian 1.12.7: **N2DN1AaWN2AaCW**

- N2: selects N2 as the current node
- D : disconnects the current node. (See below for different ways of disconnecting: disable network, disable sync)
- N1: selects N1 as the current node
- Aa: appends a token to note "a" in node 1 (this is a "logical name"; see section on naming of notes)
- W : wait until the current note in the current node is reported as synced by Obsidian
- N2: selects N2
- Aa: appends a new token to note "a" in node 2 (same "logical name" as before)
- C : connect the current node
- W : wait for sync

Interestingly, this specific history results in very consistent data loss, but only in these specific conditions:
* when disconnecting the containers' network ( `ISOLATOR=network`), but not when using the Obsidian CLI commands `sync:on` and `sync:off` (`ISOLATOR=sync`).
* when it's 2 Linux containers syncing, but it seems to fail less consistenly when it's 1 Linux vs 1 Mac instance (i.e., **N2DLAaWN2AaCW**)

Conversely, other bugs only happen between a Mac and a Linux instance, but not between 2 Linux instances. E.g. **N1DAaCLP9Aa**, reproducible in about 20% of repetitions (maybe dependent on CPU load?).

### Pacing between cross-node edits to the same note

A history can edit the same note in different nodes. This can be done conservatively (waiting for Obsidian to report it is synced) or aggressively (simulating the case of the user typing into that note at the desktop and immediately typing into that same note on the phone). This is controlled via **`TURNS`**:

- **`barrier`** (default) : there is a `W` before each cross-node edit. As far as the user can see, the node is synced.
- **`paced`** : a `P`ause command (default 10s) happens before each cross-node edit. This might or might not be enough for the sync to settle, introducing some randomness.
- **`concurrent`** : cross-node edits can happen immediately.

### Exercising sync recovery after disconnections

The main expected source of bugs is synchronization across nodes, particularly when the nodes get disconnected and reconnected to the network while the notes change.

`PARTITION_PROB` defines the probability of 'D'/'C' appearing in the history, causing a node going offline / online again.

The exact way in which nodes go offline is selected via `ISOLATOR`:

- `network`: Default. Detach/attach the container from/to a Podman network. Each of the `D`/`C` commands block until a TCP probe to a numeric address confirms the network is actually dis/connected, to avoid the possibility of Sync squeezing through. Fixed IP and MAC are used to minimize the network disruption. (Ping is not used because of complexities of rootless container vs ICMP access.)
- `sync`: Obsidian-cli `sync off` / `sync on` commands.

`SCENARIO=stale` is a separate, more fixed mode: one node disconnects early and stays offline for a long (30s) window while the
other node(s) keep editing the same note, then the stale node reconnects at the end. It mirrors the bug report of an unused device that connects after a long time offline and somehow causes a flood of conflicts.

## Outcomes

Results of a run are recorded in a directory named after the start timestamp and the history: "DD**T**HHMMSS-HISTORY". If any of the history repetitions ended up in a non-OK state, the directory name has a suffix `-BAD<pct>` indicating the % of repetitions that ended badly.

The result of each repetition of the history is recorded in a JSONL file under the history's directory, with the rep start timestamp. This file contains the history execution details: any config parameters, the execution trace and end result. If the repetition ended in a not-OK state, its name gets a suffix:

| suffix | meaning |
|---|---|
| *(none)* | PASS |
| `-LOST` | a token was writen but is gone |
| `-DUPL` | a token is duplicated |
| `-NOUPLOAD` | a token was writen in a node but never reached the server |
| `-OBSFAIL` | obsidian-cli reports something but the filesystem disagrees |
| `-UNKNOWN` | some situation couldn't be recognised |

OBSFAIL and UNKNOWN mean that something is seriously wrong and needs special handling, so they are additionally logged to runs/OBSFAIL.log and runs/UNKNOWN.log, with data to reproduce the error.

`make analyze` aggregates all the runs' information into tables in `runs/analysis.md`, to ease eyeballing of failure patterns across many histories and repetitions.

### Judging whether there was a bug: token survival

Each command `Ax` appends a unique token `(<node>-<seq>-<note>)` to the
note `x`. At the end of the history, the oracle (`src/oracle.ts`) checks that those tokens exist, either in the notes created during that history, or in any corresponding "Conflicted copy". It can detect 3 types of problems:

- **loss** : a token was introduced but at the end of the history it's been lost;
- **duplication** : a token repeated within a file;
- **divergence** : nodes disagree on final content or conflict-file set.

An appended token is read back locally; a write that doesn't read back is retried.


Nodes run with Obsidian Sync in **"create conflict file"** mode. A present conflict file is checked for
a well-formed `(Conflicted copy <device> <ts>)` name attributable to a node.



Each repeat generates one result file, `runs/<ts>-<history>/<repTs>.jsonl`. It contains the execution trace and metadata, allowing to reconstruct the scenario. A failing repeat's file is renamed with its outcome suffix (`<repTs>-LOST.jsonl`, etc.).

Timestamps are `DD**T**HHMMSS` for easy eyeballing and reference to files. Will be helpful when you have tens or hundreds of them.
Repetitions are grouped under directories named by the timestamp and history.

The notes that are created by a run in Obsidian are named `bughunt/<repTs>-<letter>-<history>`, e.g.
`bughunt/26T181530-a-N1AaN2WAa.md`. `<repTs>` is the repeat's timestamp, the trailing `-<history>` is the DSL string, and `-<letter>`
is the DSL note letter the concrete note maps to. So e.g. a multi-note
history (`NOTES>1`, `HISTORY=AaAb`) generates notes named `…-a-…`, `…-b-…`.

Eery note the harness creates lives under the `bughunt/` folder, and
`make clean-notes`/`make clean-data` only ever delete *inside* `bughunt/`. So even if pointed at a
real, in-use vault, the harness should keep your own notes safe.

**Better make backups, though.**


## Parameters

There are many ways to fine-tune how things run, though the defaults are sane. The table below shows the parameters available both at the `make` level (to be used as `VAR=value`: `make soak TURNS=paced`) and at the `npm` flag level (`npm run start -- --turns paced`).

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
| `PARTITION_PROB` | `--partition-prob` | 0 | chance per edit of a `D`…`C` partition (needs 2+ total participants — numbered nodes + the local instance if `l` is in `NODES`; a single numbered node plus the local instance is enough) |
| `ISOLATOR` | `--isolator` | `network` | `network` (partition) or `sync` (cooperative baseline) |
| `NODES` / `NETWORK` / `OBSIDIAN_BIN` | `--nodes` / `--network` / `--bin` | `n1,n2,l` / `obsidian-net` / `/opt/…` | container plumbing. `NODES` is only consulted when `HISTORY` is not set.  |
| `LOCAL_BIN` | `--local-bin` | `obsidian` | path to a **local** obsidian CLI binary, if used|
| `LOCAL_NODE_ID` | `--local-node-id` | OS's hostname | the local instance's own Sync-reported device name, used to attribute its conflict files correctly |
| `LOCAL_VAULT_PIN` | `--local-vault-pin` | off | Make most local-node commands explicitly target the vault captured at start. Enables GUI user to use another vault while testing is ongong.|
| `SKIP_HOST_CHECK` | `--skip-host-check` | off | disable the checks ensuring that the host is online (at preflight and while waiting for sync settling)|
| `POLL_SEC` | `--poll-sec` | 1 | how often (s) to re-read every node's state while waiting |
| `MIN_FLOOR_SEC` | `--min-floor-sec` | 3 | observe at least this long before declaring done — catches a sync slow to *start* right after a reconnect |
| `CAP_SEC` | `--cap-sec` | 120 | how long to wait, once not-yet-settled, before also checking whether the host itself is offline |
| `W_SETTLE_SEC` | `--w-settle-sec` | 4 | for the `W` command: how long the `synced` state must hold |
| `FINAL_SETTLE_SEC` | `--final-settle-sec` | 15 | end-of-history settle window; needs to cover a potential round-trip sync |
| `PROBE_SEC` | `--probe-sec` | 5 | per-call cap on the settle's `sync:status` probe, in case it blocks |
| `RUNS_PREFIX` | `--runs-prefix` | current path | parent dir for the whole `runs/` tree |
| `SKIP_SNAPSHOT` | `--skip-snapshot` | off | skip the whole pause-snapshot mechanism (no extra CLI calls during a `P`), in case it's suspected of perturbing timings/results |
| `WOULD_FAIL_CHECK` | `--would-fail-check` | off | opt-in early-warning: during a `P`/`W` with every relevant node online, judge a fresh observation against the real oracle; logs `would-fail` (+ `WOULDFAIL.log`) on LOST/DUPL. Off by default — every check is a real extra CLI call against the black box under test |


## Project Layout

```
src/
  dsl.ts         the history DSL: parse / serialize           (dsl.test.ts)
  generator.ts   random history generation                   (generator.test.ts)
  execute.ts     run one DSL history against the nodes, then judge
  oracle.ts      token-survival / convergence verdict         (oracle.test.ts)
  driver.ts      Obsidian CLI wrapper                         (driver.test.ts)
  cli-parse.ts   positively-recognized-output-only CLI parsers (cli-parse.test.ts; see docs/cli-trust.md)
  inconsistency.ts  classify + log a correctness-assumption violation (-OBSFAIL/-UNKNOWN) (inconsistency.test.ts)
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



## Future work (?)

A reflection: Claude Code allows you to build ideas out very quickly. But many ideas should be discarded instead of built. Friction of idea implementation against reality used to be a good indicator of idea worth; if Claude Code removes that friction... what happens? (See `make repro` example in the blog post).

So here's is a dump of ideas that may, or may not, be interesting or cool to work on.
- Obsidian is driven through its CLI, hoping that it behaves just like it would when driven through the GUI. There's an Obsidian headless option, currently in beta, that could also be interesting to try. Maybe it'll surface bugs differently to either the Linux or Mac GUI versions.
- Obsidian Sync's auto-merge mode is not tested yet. Conflict file mode is the official recommendation in the Obsidian forums' thread about data loss, so I thought I'd start here.
- Outcome judgment is very lenient: as long as the input tokens are stored *somewhere* (actual note or conflict file), the result is considered OK. However, a real user surely wouldn't be happy if their inputs keep getting moved into conflict files randomly, or if conflict files are created gratuituously. So judgment should probably be made more... judgmental.
- Both auto-merge and stricter judgment of conflict files would probably require keeping an internal model of acceptable results according to Obsidian Sync docs. That would probably be a big can of worms, given the closed-source nature of the beast.
- I started this project inspired by Jepsen. Even if it's overkill for Obsidian Sync, there could be much to learn from it; plus there's a lot of other research on fuzzing a black box with semantics, surely also including internal models of legal outputs.
- Relatedly, it'd be interesting to change the history generator so that it takes into account the failure rate of past histories to generate new ones, à la genetic algorithms. Just like AFL does.
- It would be interesting to force network failures or slowness, once Sync is solid enough over a normal network.
- The way in which Sync is blocked from working (network dis/connection vs obsidian-cli commands) changes the bugs found. What if we added some new interruption mechanism, like fully restarting Obsidian? (to model e.g. iOS quitting Obsidian because of memory pressure)
- The code driving Obsidian Sync could be made generic to work on other sync backends. Would e.g. Obsidian-on-iCloud lose more or less data? What about Syncthing, etc?
- In fact, the very Obsidian driver could be made generic to work on other programs, like Logseq. That'd be kinda funny, given that I left Logseq because of how *lossy* it was.
- The local node works directly on the host's own Obsidian instance, which limits what can be done with it: e.g., no network faults. It could be interesting to use `tart` to have a macOS VM and treat it as just another container.
- Another alternative would be to use macOS' `pfctl` to selectively block Obsidian Sync connections. But that gets into another can of worms with sudo, etc.
- Conflict files are only supposed to appear in concrete Sync scenarios. The bugs found until now are pretty clearly about conflict files failing to be created by the Obsidian client. Tuning the pause lengths is an easy way to bias towards *which* client should create a conflict file. Therefore, could the pause time be enough to pinpoint a bug?
- Looks like there's some correlation between container CPU availability and some bugs' reproducibility. Could this reduce to pause length again?
- Relatedly, given that Obsidian is closed-source, could the exact failure mode be reconstructed / reverse-engineered with DTrace / eBPF? or maybe something Electron-specific?




## Tooling

Node is pinned in `.nvmrc`, enforced by `engines` + `engine-strict`; use `npm ci`
for lockfile-exact installs.


Podman on macOS. Built the images with a view to be easy to run in AWS-EC2, but didn't try.

Developed using Claude Code, with Claude Opus 4.8 and Claude Sonnet 5, on a Claude Pro Claude subscription and no extra Claude credits.