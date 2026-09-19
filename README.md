# Obsidian Sync Bug Hunter

This is a semantic fuzzer for a simple distributed system (Obsidian Sync and its clients).
In other words, a test harness that hunts for **data loss in Obsidian Sync** when the
same note(s) are edited alternatively on multiple Obsidian instances.

Inspired by [Jepsen](https://jepsen.io/), which would be overkill for something like Obsidian Sync.

**I wrote this README personally. Everything else, including the docs/ dir, are Claude artifacts.**

# Some background: data loss in Obsidian Sync

Obsidian is a nice note-taking app. It's closed-source but free. It has a sync service, Obsidian Sync, which is subscription-based. This service has data-losing bugs. A [thread in the Obsidian forums](https://forum.obsidian.md/t/obsidian-sync-on-iphone-overwrites-newer-data-causing-data-loss/85214?u=hmijail) has been running for 2 years now gathering complaints, but the devs seem unable to find the problem. They proposed workarounds, but they fail too.

I lost data to Obsidian Sync and found that thread. I proposed using e.g. Jepsen to find bugs in a systematic way. There was no response.

I was looking for some test project to use Claude Code on, so I asked it to apply Jepsen to Obsidian. Claude jumped to make things happen; unfortunately those were pretty silly things. It quickly became clear that Jepsen is far too serious a tool for this purpose, and that Claude needs its tasks to have much, *much* tighter scope.

So I started guiding the design, following the adversarial/paranoiac themes from [DARUM](https://hmijailblog.blogspot.com/2025/04/Introducing-DARUM-DAfny-Resource-Usage-Measurement.html), which (in its own way) also plays with randomness and repetitions to force an uncollaborative black box to reveal a bit of its inner workings. Plus containers and network control.

**So 100% of the design is mine** (and this README), but **the code is 100% Claude's**. In fact, I never used TypeScript; I chose it because it's a language used in the Obsidian ecosystem... and to force myself to stay hands-off and trust Claude.

## Results

One result is that the fuzzer works: the harness finds different sequences of operations that trigger sync bugs in Obsidian, measures their repeatability and even helps understand how the sequence failed. Yay!

The other result is that Claude was surprisingly, increasingly bad at this. Full experience report [here](https://hmijail.substack.com/p/building-a-semantic-fuzzer-for-obsidian-sync-in-spite-of-claude).

The summary is that keeping Claude Code in a leash tight enough to stop it from doing silly stuff is consuming in multiple ways. It's like an intern that knows far too much for their own good, uses that knowledge to make bad choices... plus periodically forgets important points... but rarely lets go of pointless minutiae. Also, you're responsible for what it remembers, even though you only have coarse tools to control that. Also, those tools keep changing, no one knows how to best use them, and even Anthropic's instructions are too clear.

So that's a blurry mess. OK, but what did *I* learn from this project? Only things about Claude itself, the stuff that keeps changing. But nothing about the matter at hand. In fact, it's the opposite: I had to teach Claude how to build this.

**If Claude was an intern, I could expect that they learnt something, and if this was a work project maybe even that they'd take over and keep the project moving forward. But Claude doesn't learn.** The wordy, knows-too-much, unwise intern is replaced by a clone every morning, who quickly goes through the code to get an idea of what is what, and then fumbles onward.

In a nutshell: this is an **insta-legacy project**, that **ties you to LLMs**, and **requires experience, but doesn't create it**.

# Motivating example: let's lose some data

This is one sequence of operations found by the fuzzer. It causes data loss ~100% of the time in Obsidian 1.12 and 1.13.7 (latest as of this writing). Reported 2 months ago,  still not acknowledged nor fixed as of this writing.

Let’s assume you use Obsidian with Sync in your phone and your laptop. Both should set their Sync settings to “Conflict file” mode, which is the [devs’ recommendation hoping to minimize data loss](https://forum.obsidian.md/t/obsidian-sync-on-iphone-overwrites-newer-data-causing-data-loss/85214/33).

Note that this particular bug needs you to finish all the steps within 60 seconds! Later we’ll see why.

1. Set your iPhone on airplane mode; ensure Wifi is also disconnected.
2. In your laptop, created the note “buggy” (or whatever you want)
3. In that note, type “laptop”
4. Wait until Obsidian syncs up and shows the green sync icon (few seconds)
5. On your phone, create the same note “buggy”
6. In that note, type “phone”
7. Disable airplane mode on the phone and wait for sync.

After sync finishes, only the line “laptop” remains in the “buggy” note. That’s to be expected, since there was a conflict; the problem is that a Conflict File should have been created with the “phone” line, but it didn’t. So the line is gone everywhere. And you didn’t dream it: looking at the Sync version history, you’ll see that the line did indeed reach the server.

## Play-by-play timeline view

The fuzzer not only finds the sequence, but allows you to see what exactly happened in each Obsidian instance. For example, for this sequence, the fuzzer would show you a timeline like this:

XXX

'm' means that the expected note exists but is `m`issing a token. The seequence ended in that state (including a grace period), therefore we have a confirmed data loss. The fuzzer confirms this by running many repetitions to calculate how repeatable this scenario is.

## **See** how timings change Sync behavior and hide the bug

I said this example sequence needs all steps happening within 60 seconds. But why? Let's compare what happens if you wait e.g. 60 seconds just before disabling Airplane mode on the phone at step 7 (therefore ensuring that the whole sequence lasts longer than 60 seconds):

XXX
Look at what happened at second XXX: Obsidian noticed that the network is down and reported that the Sync status was bad. When the network came back up, Obsidian eventually reconnected to Sync, exercising some error recovery path that didn't trigger this particular bug: the conflict file exists now! Even further: since the error condition appeared at second XXX, we can infer that from that moment on this particular bug won't be triggered.

And that is how we know that the original sequence needs to last less than 60 seconds.

# Fuzzer features
- Sets up multiple Obsidian instances running in containers, prepared to use Obsidian Sync (requires an Obsidian Sync subscription)
- Represents sequences of user actions as a compact string (aka history)
- Can generate histories randomly, with configurabale complexity (number of nodes, number of notes, user's patience to wait for sync status, network failures)
- Runs each history for a configurable number of repetitions
- Samples whole-system behavior during the execution of histories, with configurable granularity / invasiveness
- Gathers logs of everything for later analysis, and plots timelines summarizing them
- Analyzes results, ranking histories by % of data-losing repetitions, plus flags suspicious behavior for further analysis
- Generates shell scripts implementing a history, for verifiable reproducibility of bugs with minimal machinery
- Semi-automatic upgradeability to new Obsidian versions, with self-checks to confirm whether the harness can still deal with the new version or requires modifications.


# Prerequisites

* Obsidian Sync subscription (if you want one just to test this project, know that it seems refundable during the first week)
* Podman or Docker (in macOS, 2 vCPUs / 4GB RAM in the VM is enough for 2 Obsidian containers).
* Node >= 22
* Python 3
* A VNC client to make the containerized Obsidian log in to your Sync account (and optionally to watch how Obsidian runs histories)
* Curl
* Optional:
  - Coreutils (for gtimeout)
  - Fnm (to pin down Node versions)
  - A local (non-containerized) Obsidian instance, mainly useful to find and test bugs in the macOS Obsidian version. (Needs its CLI activated)

On macOS you can install all the prerequisites with brew, and you can use the standard `Screen Sharing.app` for the VNC connection.

**No LLM is used in the harness. Bugs found can't be hallucinations.**

# Quick start

The test harness will be creating and editing lots of notes on your Sync vault. It will try to keep the vault safe, by only ever acting on notes inside a folder ("bughunt") in your vault. (In any case you should backup your vault; personally, until bugs are fixed I moved my vault out of Sync and into iCloud Drive)

`make` is the easy entry point to the project, which maps to other tools as needed. `make help` lists every available command.

Common flow:

```sh
make install && make check        # install (npm ci) + typecheck + unit tests

# Create node and prepare it for Obsidian Sync's login:
make login
# Connect through VNC to the container (localhost:5901). A pristine Obsidian is waiting. Configure it to Sync to a vault and set it to "Create conflict file". Enable the Obsidian CLI.
make capture-login                # extracts the settings and login credentials into ./secrets
make containers-up                # launch n1 + n2 fresh with the captured credentials
make unpause-sync                 # let the nodes start syncing
make check-assumptions            # does everything look as expected? (run after updates, etc)
make clean-data                   # OPTIONAL clean slate: empty the vault + wipe runs/

make run HISTORY=N1AaWN2Aa REPEAT=3      # run one specific history
make soak HISTORY=N1AaWN2Aa              # soak one history until Ctrl-C
make soak                                # generate histories and run them until Ctrl-C
make analyze                             # aggregate runs/ into a report in runs/analysis.md

make repro HISTORY=N1DAaWN2AaC           # create a shell script to run that history (bug reproduction with minimal machinery)
```


# How it all works

In a nutshell: we will set up a couple (or more!) Obsidian clients in containers, make them Sync, and then we'll create and edit notes in them, while checking that no data is lost. When it does, we'll record how repeatable is that case, in a way amenable to be reported to the Obsidian devs.

## A set of Obsidian clients, ready to Sync

When you run `make build-image`, a container image will be prepared to run Obsidian. Then, `make login` will run it for you to connect through VNC. You will log in to your Obsidian Sync account, connect to a Sync vault, enable creation of conflict files, and enable the Obsidian CLI.

Next, `make capture-login` will extract from that container your Sync credentials and copy them into the `secrets` directory. This is so that multiple containers can reuse the same credentials, without manually setting up each one of them individually. This information never leaves your computer. **Don't publish that directory; it's already in `.gitignore`.**

And then, `make containers-up` will start your nodes and get them syncing. If there's notes in the vault, they might take some time to finish their initial sync.

If you want to see or interact with them, you can always connect to each node through VNC, in the port 5900+(node number).

## Generating sequences of Obsidian edits with a tiny DSL

We will test sequences of actions, AKA **histories**. A history is a string of user actions replayed against
multiple Obsidian nodes. Commands are uppercase, parameters lowercase/digits.

| Command | meaning |
|---|---|
| `N<d>` | set the active node (`N1`, `N2`) |
| `L` | set the active node to local Obsidian instance |
| `A<x>` | make the active node append a uniquely-tagged line to note `x` (creates it if necessary) |
| `D` / `C` | disconnect / connect the active node from the network (applies to containers, not the Local node)|
| `W[n]`  | wait until the active node is synced (with optional timeout of `n` seconds) |
| `P[n]` | pause ~`n` seconds (default 10) |

Example: `N1AaWN2Aa`= node 1 appends to note `a`, waits for sync; node 2 appends to the same note.

At the end of the history, the harness reconnects all nodes to the network,  waits for them all to report synced, and still waits for a settling window to ensure that no further changes happen (e.g. generation of conflict files, which later get synced, which could still generate conflicts in other clients, etc etc). An end result is judged only when things remain stable for `FINAL_SETTLE_SEC` seconds.

Note that the harness models a single user using Obsidian across multiple devices, so there's a single thread of control doing everything. This means that e.g. a Pause command applies across all nodes at once: the control thread does nothing for n seconds, while the Obsidian nodes will keep doing their thing (e.g. try to sync). Similarly, W waits for the current node to be synced, which doesn't stop the rest of nodes from working.

Histories can be auto-generated randomly (each op's probability is adjustable, see [Parameters](#parameters-to-make-and-npm)) or typed manually. They are normalized so that histories that would be similar in practice also look similar as a string (see the [History Normalization](#history-normalization) section).

Timings are unavoidably variable across repetitions of a history, since we don't have control of the Sync server, internet traffic, etc. This might cause Sync results to change every time you repeat the history. Therefore histories are run for `REPEAT` times to sample the distribution of end results. If one wants to minimize variability, command W waits until Obsidian the node is synced.

Edits to notes are append-only (for now?), since that is a case supported by the CLI. Edits optionally (`OPEN_NOTES`) can also open the note in the nodes' GUI, so you can watch the history unfold through a VNC connection if you want to.

### One key difficulty: `W` formalizes (somewhat) the synced status

Syncing is hard. It can happen that the user is editing stuff while changes are coming in or out of Obsidian. It can even happen that something is wrong with the network and syncing gets delayed, accumulating conflicting changes at different points of the process, while you, the user, might not know or even care that this is happening; you count on Obsidian to deal with that for you.

While this is perfectly reasonable for a normal user (after all that's the premise of many sync solutions like Obsidian Sync), for the fuzzer to do its job better we need to try to formalize the different underlying scenarios. Hence, `W` doesn't only trust the Sync status reported by Obsidian (which corresponds to the Sync icon in the GUI), but also checks metadata from the Sync server and content of modified notes; it will only let the history continue when the synced status does seem correct (and will otherwise record a data loss bug if it looks wrong after a configurable grace period).

On the other hand, Obsidian Sync bugs might also get triggered by an impatient user who tries editing notes while the Sync status is not settled. This case is covered by `W<n>`. For example, `W10` simulates a user who waits for 10 seconds for the GUI Sync icon to show activity; after that, they just go ahead and edit a note.


## Practical example

The [motivating example](#motivating-example) at the beginning of this README was found by the fuzzer as this history: **N2DN1AaWN2AaCW**

(Found in Obsidian 1.12.7, still there in 1.13.7)

- N2: selects N2 as the current node
- D : disconnects the current node
- N1: selects N1 as the current node
- Aa: appends a token to note "a" in node 1 (this is a "logical name"; see section on naming of notes)
- W : wait until the current note in the current node is reported as synced by Obsidian
- N2: selects N2
- Aa: appends a new token to note "a" in node 2 (same "logical name" as before)
- C : connect the current node
- W : wait for sync

Interestingly, this history results in data loss only when D/C is implemented by the network disconnecting and reconnecting (`ISOLATOR=network`, default), but not when implemented by Obsidian Sync being turned off and on through the CLI (`ISOLATOR=sync`).
XXX
* when it's 2 Linux containers syncing, but it seems to fail less consistenly when it's 1 Linux vs 1 Mac instance (i.e., **N2DLAaWN2AaCW**)

Conversely, other bugs only happen between a Mac and a Linux instance, but not between 2 Linux instances. E.g. **N1DAaCLP9Aa**, reproducible in about 20% of repetitions (maybe dependent on CPU load?).

## Timelines
Running a history creates long logs. For easier inspection, these are summarized into an ASCII timeline that shows what happened, where and when.

TImelines consist of lanes (rows), with each lane dedicated to one type of sample, with various letters representing events.
Samples that are taken at the same time are plotted in the same column. For ease of reference, seconds are separated by columns of |.

Letter meanings:
- **general**: `x` the call was cut off · `?` reply not recognised ·` ` not sampled · `|` a wallclock second
- **ops**:`a`/`b`/… a note was written to · `D`/`C` disconnect/connect · `W` a wait started · `P` a pause · `h` a `W<n>` handed off early
- **sync**: `.` synced · `s` syncing · `p` paused · `e` error · `o` offline · `h` stopped
- **vers**: a digit when the server version counter moved, to that value ·
  `.` sampled but unchanged · `-` no server history yet
- **file** (per node per note) — `.` file is complete and unchanged · `u` file changed here, is complete · `m` missing a token · `M` changed here, missing a token · `c` changed here and a conflict file appeared · `C` same, but some token is missing · `-` no file · `L` loss declared · `!` readings that do not add up

A column where nothing was sampled will be empty. If full of dots, sampling happened but there was nothing interesting.


## Pacing between cross-node edits to the same note

A history can edit the same note in different nodes: e.g., `N1AaWN2Aa`. This can be done conservatively (i.e., waiting for Obsidian to report it is synced, like in this example) or aggressively (as if the user typed into a note at the desktop and immediately afterwards typed into that same note on the phone). This is controlled via **`FORCED_TURNS`**, which contains ops that will be introduced in generated histories whenever a note is edited across different nodes. Some examples:

- **`FORCED_TURNS=W`** **(default)** : before switching nodes, there is a `W`ait for confirmed upload of changes.
- **`FORCED_TURNS=P60`** : a `P`ause command (of 60s in this case) is inserted before switching nodes.
- **`FORCED_TURNS=`** (empty) : cross-node edits can happen immediately. Unrealistic, but maybe useful as a stress test (...once Obsidian Sync can deal with easier scenarios).

## Exercising sync recovery after disconnections

The main expected source of bugs is synchronization across nodes, particularly when the nodes get disconnected and reconnected to the network while the notes might keep changing. Just as if you edited a note on your phone on the go, while connectivity comes and goes.

`CD_PROB` defines the probability of `D`isconnect/`C`onnect appearing in a history, causing a node going offline / online again.

The exact way in which nodes go offline is selected via `ISOLATOR`:
- `network`: Default. Detach/attach the container from/to the container network, while keeping its IP.
- `sync`: Obsidian-cli `sync off` / `sync on` commands. Note that this is unrealistically benevolent to Obsidian!

## Using a `L`ocal node

Containers virtualize Obsidian clients that run on Linux. But what if we want to introduce a Mac client? Bugs might be different, so confirming reproducibility would be nice.

A possible future improvement could be to use a Mac VM (or even an iPhone simulator). But for now, if you are in a Mac, then you don't need to virtualize it! You can have the harness talk to your local Obsidian: just open the Sync vault and use `L` in your histories, or use e.g. `make soak NODES=n1,l` so that generated histories include the local node.

Of course this means that while the histories are being run, your Obsidian client will be doing stuff to this vault. You should not disturb it (e.g. by changing the note in focus), so it's best to do this when you will not be using Obsidian yourself, e.g. during the night.

That said, if you have multiple vaults, you could keep the Sync vault in its own window while you use any other in a different window. The harness will do its best to detect that you switched vaults and pause until you return focus to the Sync vault. Even further, if you add the `LOCAL_VAULT_PIN=on` arg, the harness will *try* to force Obsidian to use the Sync vault even if the GUI is working in a different one. These options are best-effort though.

## Outcomes

### Automatic analysis

`make analyze` aggregates all the runs' results into tables in a file `runs/analysis.md`, to ease eyeballing of failure patterns across many histories and repetitions.

It also surfaces timing distributions, which might end up hinting at the reason why some history reps were successful while others lost data.

One can also comb manually through the logs. Read on for the gory details.


### Logs, naming conventions and directories

The main idea is that eyeballing the `runs/` directory should quickly allow you to see what histories were run, how many of their repetitions failed and why, and then zero in to the interesting cases:
* At the top level there's directories named after each history: `runs/<timestamps>-<history>[-<RESULT>]/`
* Inside of each history, there's the log for each of its repetitions: `<timestamp>[-RESULT].jsonl`.

Each log contains all the information needed to reconstruct the scenario.

Timestamps are formatted as `DD`**`T`**`HHMMSS` for ease of eyeballing and of cross-referencing. This will be helpful when you have dozens of files and directories and need to relate an Obsidian note against a particular history and repetition.

The notes that are created in Obsidian are named `bughunt/<repTs>-<letter>-<history>`, e.g.
`bughunt/26T181530-a-N1AaN2WAa.md`. `<repTs>` is the repetition's timestamp, the trailing `-<history>` is the DSL string, and `-<letter>` is the DSL note letter the concrete note maps to. So e.g. a multi-note
history (`NOTES>1`, `HISTORY=AaAb`) generates notes named `…-a-…`, `…-b-…`.

If any of the history repetitions ended up in a non-OK state, its log's filename gets a suffix according to the failure:

| rep suffix | meaning |
|---|---|
| *(none)* | PASS |
| `-LOST` | a token was writen but disappeared. **Data loss!** |
| `-DUPL` | a token is duplicated |
| `-NOUPLOAD` | a token was writen in a node but never reached the server |
| `-OBSFAIL` | obsidian-cli reports something but the filesystem disagrees |
| `-UNKNOWN` | some situation couldn't be recognised |
| `-ENVFAIL` | a container took too long to reconnect |
| `-ABORTED` | interrupted by ^C |

OBSFAIL, UNKNOWN and ENVFAIL mean that something is seriously wrong and needs special handling, so they are additionally logged to files in `runs/{OBSFAIL, UNKNOWN, ENVFAIL}.log`.

If a rep was non-OK, then the containing directory also gets a suffix `-BAD<pct>` indicating the % of repetitions that ended badly.


### Judging whether there was data loss: token survival

Each command `Ax` in a history appends a unique token `(<node>-<seq>-<note>)` to the note `x`. At the end of the history, the oracle (`src/oracle.ts`) checks that those tokens are still there. It can detect 3 types of problems:

- **loss** : a token was introduced but at the end of the history it's been lost;
- **duplication** : a token is repeated;
- **divergence** : nodes disagree on final content or conflict-file set.

Nodes run with Obsidian Sync in **"create conflict file"** mode, and the oracle checks for tokens either in the notes explicitly created during that history, or in any corresponding "Conflicted copy" created by Obsidian.

## Cleaning up

The harness creates its notes in the `bughunt/` folder of the Obsidian vault, and
`make clean-notes` only ever deletes in that folder. So even if pointed at a
real, in-use vault, the harness should keep your own notes safe. **You should have backups, though.**

The contents of the `runs/` directory can be deleted at will. `make clean-runs` will do so.

`make clean-data` cleans both notes and logs.



# Future ideas (?)

A reflection: Claude Code allows you to build ideas out very quickly. But many ideas should be discarded instead of built. Friction of idea implementation against reality used to help filter the craziest stuff out; if Claude Code removes that friction... what happens?

So here's is a dump of ideas that may, or may not, be interesting or cool to work on.
- Obsidian is driven through its CLI, hoping that it behaves just like it would when driven through the GUI. There's an Obsidian headless option, currently in beta, that could also be interesting to try. Maybe it'll surface bugs differently to either the Linux or Mac GUI versions.
- Obsidian Sync's auto-merge mode is not tested yet. Conflict file mode is the official recommendation in the Obsidian forums' thread about data loss, so I thought I'd start here.
- Outcome judgment is very lenient towards Obsidian: as long as the input tokens are stored *somewhere* (actual note or conflict file), the result is considered OK. However, a real user surely wouldn't be happy if their inputs keep getting moved into conflict files randomly. So judgment should probably be made more... judgmental.
- Both auto-merge and stricter judgment of conflict files would probably require keeping an internal model of acceptable results according to Obsidian Sync docs. That would probably be a big can of worms, given the closed-source nature of the beast and how little is pinned down in the docs.
- I started this project inspired by Jepsen. Even if it's overkill for Obsidian Sync, there could be much to learn from it; plus there's a lot of other research on fuzzing a black box with semantics, surely also including internal models of legal outputs.
- Relatedly, it'd be interesting to change the history generator so that it takes into account the failure rate of past histories to generate new ones, à la genetic algorithms. Just like AFL does.
- It would be interesting to force network failures (packet loss) or slowness, once Obsidian Sync is solid enough over a well-behaved network.
- In fact, the way in which Sync is blocked from working (network dis/connection vs obsidian-cli commands) changes the bugs found. This hints at Obsidian behaving specially on those commands. So, what if we added some new interruption mechanism, like suddenly killing Obsidian? (to model e.g. iOS quitting Obsidian because of memory pressure)
- Interposing a MITM proxy on the Sync protocol might allow to have a reliable oracle of sync status, instead of just recording what Obsidian reports. That would allow to characterize client state independently of timers.
- The code checking Obsidian Sync status could probably be made to work on other sync backends. Would e.g. Obsidian-on-iCloud lose more or less data? What about Syncthing, etc?
- In fact, the very Obsidian driver could be made generic to work on other programs, like Logseq. That'd be kinda funny, given that I left Logseq because of how *data-lossy* it was.
- The local node's purpose is to allow a Mac Obsidian client into the otherwise Linux mix. But since the local node works directly on the host's own Obsidian instance, this limits what can be done with it: e.g., no network faults (because it would also kill the containers' network). So it could be interesting to remove that local corner case and instead use `tart` to have a macOS VM, just as another ~container.
- Another alternative would be to use macOS' `pfctl` to selectively block Obsidian Sync connections. But that gets into another can of worms with sudo, etc.
- Conflict files are only supposed to appear in concrete Sync scenarios. The bugs found until now are pretty clearly about conflict files failing to be created by the Obsidian client. Tuning the pause lengths is an easy way to bias towards *which* client should create a conflict file. Therefore, could the pause time be enough to pinpoint a bug in the code?
- Looks like there's some correlation between container CPU availability and some bugs' reproducibility. Could this reduce to pause length again?
- Relatedly, given that Obsidian is closed-source, could the exact failure mode be reconstructed / reverse-engineered with DTrace / eBPF? or maybe something Electron-specific?




# Reference
## History Normalization

Histories are normalized to ensure they make sense, and so that those histories that would be similar in practice also look similar as a string. Example: history `N1CPN2CAaAa` would be reduced to `N2PAa`:
- Histories start with all nodes connected, and redundant Dis/Connects are removed. (`N1CPN2CAaAa` → `N1PN2AaAa`)
- A Pause not adjacent to an action (`D`/`C`/`A`/`W`) floats forward to the next action (`N1PN2AaAa` → `N1N2PAaAa`)
- Redundant node selections vanish (`N1N2PAaAa` → `N2PAaAa`)
- Contiguous Appends to the same note collapse into a single Append. (`N2PAaAa` → `N2PAa`)



## Upgrading Obsidian

A new Obsidian version will eventually be released and you'll want to check if the bugs you found are still there.

```sh
make obsidian-latest                     # check latest GitHub .tar.gz release of Obsidian
make obsidian-upgrade                    # update the Obsidian version number that will be used
make containers-up                       # rebuild the image + relaunch the nodes
make check-assumptions                   # does everything look right?
```
The captured login information should keep working all the same.


## Checking the assumptions this harness rests on

For our experiments to make sense, we depend on quite a few things that could change after a software update: the container engine and its networking behavior, the output format of the obsidian-cli command, the timings of it all, etc. So there's a Makefile target to check that everything still looks as expected.

```sh
make containers-up
make unpause-sync
make check-assumptions     # when coming back to the project after a long break, a software update, etc
```

## Other auxiliary tools

`make timeline-rep REP=...` plots the rep's timeline from the data in the given log.

`make probe-propagation` runs histories with the goal of measuring the timings imposed by Obsidian: when is an edited note synced to the server? Are writes batched? How long until the other clients download it? As of 1.13.7, syncs happen immediately on first write, but subsequent ones are spaced to happen once every 10s per note.

`make bench-cli` measures the speed of running various Obsidian sampling commands in a container, sequentially or in parallel, batched or not. It helps ensure that the sampling mechanisms being used are still the fastest available.

## Parameters to make and npm

There are many ways to fine-tune how things run, though the defaults are sane. (In fact, having so many available parameters feels like something I wouldn't do :P)

The table below shows the parameters available both at the `make` level (to be used as `VAR=value`: `make soak FORCED_TURNS=P`) and at the `npm` flag level (`npm run start -- --forced-turns P`).

Histories are generated by drawing ops randomly, one at a time. There's parameters to adjust the probability of each op, relative to `A`'s 1.


| make var | CLI flag | default | meaning |
|---|---|---|---|
| `HISTORY` | `--history` | *(generate)* | run a specific DSL string instead of generating |
| `STEPS` | `--steps` | — | with `HISTORY`: run only its first N ops |
| `REPEAT` | `--repeat` | 10 | repeats per history |
| `HISTORIES` | `--histories` | 1 | number of histories to run (≤0 = until killed) |
| `DURATION_MIN` | `--duration-min` | — | run for (at least) N minutes instead of a count |
| `OPS` | `--ops` | `6-12` | edit-count range — counts **`A` only**; collapse may leave fewer. A single number (`9`) fixes the count (same as `9-9`) |
| `NOTES` | `--notes` | 1 | max number of potential notes being edited per generated history |
| `FORCED_TURNS` | `--forced-turns` | `W` | ops inserted between edits across nodes (see `Pacing` section) |
| `PAUSE_PROB` | `--pause-prob` | 0.3 | draw probability for a P |
| `PAUSE_SEC` | `--pause-sec` | 10 | length of an ordinary pause |
| `LONG_PAUSE_PROB` | `--long-pause-prob` | 0.25 | chance that an emitted pause is a long one |
| `LONG_PAUSE_SEC` | `--long-pause-sec` | 100 | length of a long pause |
| `WAIT_PROB` | `--wait-prob` | 0.2 | draw probability for a standalone W |
| `CD_PROB` | `--cd-prob` | 0.4 | draw probability of a `D`/`C` |
| `ISOLATOR` | `--isolator` | `network` | `network` (partition) or `sync` (cooperative baseline) |
| `NODES` / `NET` / `OBSIDIAN_BIN` | `--nodes` / `--net` / `--bin` | `n1,n2` / `obsidian-net` / `/opt/…` | container plumbing. `NODES` is only consulted when `HISTORY` is not set.  |
| `LOCAL_BIN` | `--local-bin` | `obsidian` | path to a **local** obsidian CLI binary, if used|
| `LOCAL_NODE_ID` | `--local-node-id` | OS's hostname | the local instance's own Sync-reported device name, used to attribute its conflict files correctly |
| `LOCAL_VAULT_PIN` | `--local-vault-pin` | off | Make most local-node commands explicitly target the vault captured at start. Enables GUI user to use another vault while testing is ongoing.|
| `SKIP_HOST_CHECK` | `--skip-host-check` | off | disable the checks ensuring that the host is online (at preflight and while waiting for sync settling)|
| `POLL_SEC` | `--poll-sec` | 1 | how often (s) to re-read every node's state while waiting |
| `MIN_FLOOR_SEC` | `--min-floor-sec` | 3 | observe at least this long before declaring done, to catch syncs slow to start after a Connect |
| `CAP_SEC` | `--cap-sec` | 120 | how long to wait, once not-yet-settled, before also checking whether the host itself is offline |
| `FINAL_SETTLE_SEC` | `--final-settle-sec` | 15 | end-of-history settle window; needs to cover a potential round-trip sync |
| `PROBE_SEC` | `--probe-sec` | 5 | per-call cap on the settle's `sync:status` probe, in case it blocks |
| `RUNS_DIR` | `--runs-dir` | current path | parent dir for the whole `runs/` tree |
| `SKIP_SNAPSHOT` | `--skip-snapshot` | off | skip the whole pause-snapshot mechanism (no extra CLI calls during a `P`), in case it's suspected of perturbing timings/results |
| `CONTAINER_ENGINE` | - | *auto* | `docker` if it's on `PATH`, otherwise `podman` |
| `RECONNECT_BUDGET_MS` | `--reconnect-budget-ms` | 1000 | if a container takes longer than this to reconnect, abort with ENVFAIL |
| `PREFIX` |	`--prefix`	| - |	fixed starting ops prefixed to histories |
| `SAMPLING` | `--sampling` | `strategic` | `strategic` samples status and timings only where it's estimated to be necessary, hoping to avoid disturbing Obsidian. `everything` samples at every node, even if they aren't active in the history. `everything-no-sleep` samples everywhere, as frequently as possible. |
| `DISPLAY` | `--display` | `end` | `end` prints the timeline block after each rep, `bar` keeps it pinned as a live status bar above the scrolling log, `off` suppresses it |
| `OPEN_NOTES` | `--open-notes` | off | make Obsidian open the note being edited in the GUI, allowing the history to be watched as it happens. |
| `LOSS_GRACE_SEC` | `--loss-grace-sec` | 60 | when `W` detects that Sync is finished but a token is missing, it waits for this long before recording a case of data loss |


## Project files layout

```
src/
  dsl.ts         the history DSL: parse / serialize           (dsl.test.ts)
  floor.ts       calculate minimal expected history duration for sanity check (floor.test.ts)
  generator.ts   random history generation                   (generator.test.ts)
  execute.ts     run one DSL history against the nodes, then judge
  oracle.ts      token-survival / convergence verdict         (oracle.test.ts)
  driver.ts      Obsidian CLI wrapper                         (driver.test.ts)
  cli-parse.ts   positively-recognized-output-only CLI parsers (cli-parse.test.ts; see docs/cli-trust.md)
  inconsistency.ts  classify + log a correctness-assumption violation (-OBSFAIL/-UNKNOWN) (inconsistency.test.ts)
  exec.ts        Local / container executors
  engine.ts      which container engine (podman/docker) to drive (engine.test.ts)
  isolate.ts     fault primitives (network partition / sync toggle)
  net.ts         host-internet connectivity probe (tells a Sync stall apart from a host outage)
  types.ts       shared types (NodeId, ExecResult, token format, NOTE_DIR)
  history.ts     per-rep JSONL trace (one file, opens with `history`, closes with `results`)
  runner.ts      single divergence-round (used by run-local)
  run.ts         containerized entrypoint   (npm run start)
  run-local.ts   single-node pipeline check (npm run local)
  analyze.ts     offline soak aggregator    (npm run analyze)
  clean-notes.ts delete the harness's notes (bughunt/) on all nodes (npm run clean-notes)
  check-cli.ts   assert every obsidian-cli command still parses  (npm run check-cli)
  probe-sync-versions.ts  probes sync:history command behaviors
  smoke.ts       driver probe               (npm run smoke)
  arrivals.ts    date each token's arrival on the other node       (arrivals.test.ts)
  latency.ts     upload/download latency distributions for analyze (arrivals.test.ts)
  repro.ts       turn a history into a standalone shell script
  corpus.ts      cross-history survey of runs/                    (arrivals.test.ts)
  probe-propagation.ts  where a change's time goes, live and visual
  timeline.ts    lanes-of-characters renderer, shared by the probe, the log reconstruction
                 and the live status bar                          (timeline.test.ts)
  timeline-rep.ts  reconstruct one rep's timeline from its .jsonl (npm run timeline-rep)
containers/      Dockerfile + entrypoint (Obsidian under Xvfb)
scripts/
  wait-node.sh   block until a node is genuinely ready (GUI alive, then Sync CLI answering)
  check-net.sh   verify a D/C reconnect is still a brief blip on this engine (make check-net)
  check-assumptions.sh   general environment sanity check
  repro-lib.sh   bash runtime sourced by every `make repro` script
  bench-cli.sh   what one obsidian-cli call costs, vs an empty exec and vs the FS (make bench-cli)
  bench-render.py  its table renderer: min/med/p90/max/span plus a shared-scale histogram
docs/
  cli-trust.md   why/how the harness never judges from CLI output it didn't positively recognize
  DESIGN.md      architectural reasoning + dead ends
Makefile         container lifecycle and general entry points
```


