# Design decisions and dead ends

Broader architectural narrative that doesn't fit `docs/cli-trust.md`'s CLI-output-trust theme —
why things are shaped the way they are, and paths considered and rejected. Like `cli-trust.md`,
this is a record of reasoning, not a spec: when the black box it's reasoning about changes (a new
Obsidian version, a new podman/Docker release), the conclusions here may need resampling. What
should stay true regardless is the general ethos this repo follows — verify everything through an
explicitly recognizable path, log every step, fail hard on the unknown.

Where a conclusion here is load-bearing enough that its silent expiry would corrupt results
rather than merely break something, it gets an executable check instead of a paragraph — see
`make check-net` under "Network identity" below.

## Network identity: pinning the same IP across reconnects

`isolate.ts`'s `nodeIp()` derives a fixed IP per node (`n1` → `10.89.0.101`, etc.) and re-applies
it on every reconnect, rather than letting the engine assign a fresh one each time.

**The point is which experiment a `D`…`C` pair actually runs.** What we want to simulate is a
device that loses connectivity for a few seconds and gets it back: its TCP connections to Sync
stall, then resume where they left off. What we do *not* want is a full network reset — the node
reappearing as a different address, its old connections dying on timeout, and Obsidian taking its
error-handling/rejoin path instead. That second thing turns a 10-second outage into a
minute-long one and exercises entirely different code. Both are legitimate experiments, but only
one of them is what a history like `N2DN1AaWN2AaCW` claims to be testing, and a run that silently
does the other is a run that means something different than its label.

Keeping the **IP** is what secures this: TCP connections are keyed on the address 4-tuple, so an
unchanged IP lets the stalled connections simply resume. Measured on Docker 29.7.2 (see
`scripts/check-net.sh`): a container reconnected with `--ip` was reachable again within ~50ms of
the `network connect` command returning, and a peer-to-peer TCP stream held open across a 10s
outage resumed with its byte stream intact and no gap.

### Dead end: pinning the MAC too

The harness used to pin a per-node **MAC** alongside the IP (`6e:62:6e:65:74:<X>`), on the theory
that a device Sync recognizes as unchanged would rejoin faster. It was removed; git history has
the code if it is ever wanted back.

It was never load-bearing. Disconnecting destroys the container's interface, and its ARP cache
goes with it, so on reconnect the node must re-ARP for its gateway anyway — and that ARP request
carries whatever MAC it now has, updating the peer's neighbour entry immediately. There is no
stale-ARP blackhole to wait out, and nothing above layer 2 ever sees the address: the TCP 4-tuple
that decides whether connections resume is IP and port only.

Two things then made it worse than useless. It was the harness's **only** engine-specific
behaviour: `docker network connect` has no `--mac-address` flag, and the plausible `--driver-opt
com.docker.network.endpoint.{mac_address,macaddress,mac-address}` spellings are all accepted
silently (exit 0) while a fresh random MAC is assigned anyway — so supporting it meant a
capability probe (`connectPinsMac`), a conditional argument in four places, and a `macPinned`
field on every `network-identity` event, all to record which of two identities survived a
reconnect that behaves identically either way. And it produced a *measurement asymmetry between
engines* for something the experiment does not depend on, which is precisely the kind of
difference that invites false attribution when a finding shows up on one machine and not another.

With it gone, podman and Docker are driven by identical commands with identical flags everywhere
in the harness; the only remaining difference is the Makefile's explicit `--subnet` (the two
engines default differently).

The old MAC scheme carried one non-obvious constraint worth preserving in case it ever returns.
The first byte was `0x6e` ('n', for "nbnet") rather than the more on-the-nose `0x6f` ('o', for
"obnet") for a real reason: a MAC's first byte's least-significant bit is the I/G
(individual/group) bit — 0 for unicast, 1 for multicast — and `0x6f` has it set. Podman's rootless
backend (netavark) refuses to assign a multicast address to a real interface, confirmed live
(`Error: netavark: create veth pair: Netlink error: Cannot assign requested address`) before
switching to `0x6e`, which also has the U/L (locally-administered) bit set — correct for a
made-up, non-vendor-assigned address.

**This is an assumption about engine internals, so it is checked rather than trusted.**
`make check-net` (`scripts/check-net.sh`) measures it deliberately on a disposable container —
reconnect latency against a budget (default 1s) plus a hard assertion that the pinned IP survived
— and `make check-assumptions` folds that in with the rest of the environment checks. That
deliberate measurement is needed because a history containing no `D` never exercises the primitive
at all.

The same budget rides along on every real `C` at runtime (`NetworkIsolator.reconnectBudgetMs`), and
exceeding it **aborts the run**: the rep is tagged `-ENVFAIL`, the cause is appended to
`runs/ENVFAIL.log`, and the operator gets a remediation block rather than a stack trace.

Aborting is the point, and it was originally got wrong here. The tempting design is to record a
slow reconnect and carry on, the way a host-outage detour is handled — but those are different
kinds of thing. A host-outage detour spoils one rep's *timings*; a slow reconnect means the fault
primitive itself is broken, so every following rep in the soak is equally meaningless. A run that
keeps going is a run quietly manufacturing results about a different experiment than the one its
histories describe. It is also not the harness's usual "don't misreport infrastructure as an
Obsidian finding" case: `-ENVFAIL` is deliberately excluded from `FAIL_SUFFIXES`, so it never
counts toward a history's `-BAD<pct>`.

On a genuinely slow machine, raise the bar rather than lose the signal:
`make ... RECONNECT_BUDGET_MS=2000`.

## `W` is a self-report, so where a forced turn sits decides whether it means anything

`W` waits until the **active** node's own client reports `synced` — never a verified fact about the
server or the other node. A sync can be pending with nobody able to tell; that is the whole premise
of `docs/cli-trust.md`. Which node is active when the `W` runs therefore decides what it is worth.

The generator used to force its `TURNS=barrier` wait *after* moving the cursor, producing
`N1AaN2WAa`: n2 waits before editing. But n2 has not edited, so it has nothing pending, so its
client reports `synced` immediately — and it can do so while entirely unaware that n1's edit exists.
The `W` then returns as fast as the harness itself allows.

Measured over 1,973 mid-history `W`s recorded in `runs/`:

| | n | min | median | p90 | max |
|---|---|---|---|---|---|
| mid-history `W` (old placement) | 1973 | 4s | 5s | 7s | 16s |
| final settle | 1401 | 16s | 23s | 60s | 112s |

**82% of them (1630/1973) returned at 4-6s**, the mechanism's own floor. They were not waiting *for*
anything; they were serving out the harness's quiet window. Empirically `TURNS=barrier` was
`FORCED_TURNS=P5`. The final settle, which waits on every node for every note, is the contrast: it
genuinely waits.

This matters beyond tidiness. Soaks run under the old placement were sampling near-unpaced hand-offs
with an incidental five-second delay, not the barrier their history strings implied — so losses found
there came from a more aggressive regime than the `W`s suggested.

Hence `FORCED_TURNS` is now emitted **before** the cursor moves, so it runs on the node that just
edited: `N1AaWN2Aa`. That is the glance at the sync indicator a user really takes before picking up
another device — blind spot and all, since it is still only a self-report. The blind spot is the
point: the interesting question is not "wait until it is safe" but "wait until Obsidian says it is
safe", and the gap between those is where the bug lives.

### The ~4s floor is the harness's paranoia, not a user model

It is tempting to read that floor as simulating a user studying the sync icon. It is not. It comes
from `wSettleSec` (default 4), the window `waitForSynced` requires the observed state to hold
*unchanged* before believing it — because a single `synced` reading can be transient, and sampling
mid-flux is how the harness would fabricate verdicts. `minFloorSec` (default 3) sits underneath it
for the same kind of reason.

Both are knobs (`--w-settle-sec`, `--min-floor-sec`), so a more aggressive experiment is available —
but lowering only `wSettleSec` gets you to 3s, not 0, since the floor then dominates. Lowering both
buys speed by trusting a single sample, which is the one thing this codebase consistently refuses to
do. Worth knowing the lever exists; not worth pulling by default.

## The server version counter cannot see a pending sync

`sync:history file=<n> total` gives a server-side count of versions for a note. It is tempting as a
signal the *user* does not have: if it rose while a node still lacked the content, the harness could
tell that a sync was in flight — catching the case of a user who waited, gave up, and edited anyway.

It cannot. Measured with `npm run probe-sync-versions`:

| | |
|---|---|
| cost on a settled node | ~170ms |
| n1 appends, then reads its OWN total | still the old value, for ~9s |
| n2's total while its content lacks the token | unchanged, every poll |
| when the counter rises | the same poll in which the content arrives |
| after a real partition + reconnect | identical: 153-195ms, counter and content flip together |

The counter is a *local* view of server history that moves in lockstep with the content, not ahead of
it. Even the **writing** node's own total did not count its edit until nine seconds later, at the
moment the peer received it. So it offers no lead time over simply reading the file, and neither of
the interesting uses is available: a wait cannot be made to honour it (it says nothing the content
does not), and a "you gave up while a sync was pending" detector cannot be built on it.

What it does support is what it is already used for: `total < 1` means a note never reached the
server at all, which is `-NOUPLOAD`. That remains a hidden signal reaching a verdict, deliberately —
it catches a note living on exactly one device, a durability failure the user cannot see.

### The long blocks are real — but the code names the wrong cause

`execute.ts` reads the baseline lazily because `sync:history total` "blocks until the queried node
has **caught up**", and `driver.ts` bounds each attempt against reads that "can silently block for a
long time". The blocking is real. The stated cause is not.

A node that is merely behind answers fine: every call in steps 1-6 returned in 150-200ms, including
the first on a just-reconnected node with a version still pending. What actually blocks is a node
with **no network at all** (probe step 7):

    n2 disconnected
    attempts 1-8   5.0s each, killed at the per-attempt cap   <- 40s of genuine blocking
    attempt  9     4.0s, "Failed to retrieve sync history: Cannot read properties of null (reading 'send')"
    attempts 10-15 ~0.1s each, "Error: Sync is in error state. Check sync settings."
    total wall time 75.3s

So the client hangs while it still believes it can reach the server, throws an internal error as it
gives up, and only then starts answering promptly with a recognizable refusal.

The lazy baseline therefore protects correctly, but by accident: it is gated on `everySynced`, and a
disconnected node cannot report `synced` — not because "synced" implies caught up, but because it
implies *has a network*. Worth knowing before anyone simplifies that gate away on the grounds that
catching up is fast. It is; being offline is not.

**Do not make the baseline eager.** The temptation is that `from` is only sampled once a node already
claims `synced`, so the recorded `from`→`to` covers only the tail of a wait; reading it up front would
make the span cover the whole wait. But that buys no new *information* — the counter never leads the
content (above), so a wider span records the same events more tidily and reveals nothing extra. And
it carries an untested risk: everything measured here reconnects at the node's **pinned IP**, so the
client's existing connection resumes. A node returning on a *different* address — the wifi-to-cellular
case — would have its old socket die on timeout instead, which is exactly the situation where a
client might sit on a dead connection. Nobody has measured that, and there is no reason to take the
risk for tidier bookkeeping.

Also note the blocking is specific to files the client believes have server history: querying
`sync:history` for a note that does not exist answers "not found" in milliseconds even with no
network. An offline check that forgets to create its note will quietly measure nothing — which is how
the first version of `--check` fooled itself.

It also explains the shape of the defences: `RECOGNIZE_CALL_TIMEOUT_MS` turns those 5s hangs into a
visible retry sequence instead of one silent 40s stall, which is exactly what the retry log above
shows.

## The local node (`L`): a grammar token, not a parallel code path

Adding a real Obsidian instance running directly on the host as a harness participant could have
meant threading a separate `localDriver` parameter through every function that iterates `drivers`
— `driverOf`, `waitNodesSynced`, the final settle, the oracle. Instead, `L` is a DSL-grammar-level
token, but it resolves to an ordinary position in the *same* `drivers` array (always pushed last)
the instant `execute.ts` processes the op — so everything downstream treats it exactly like any
other node, with zero special-casing. The grammar-level distinction exists for exactly one reason:
the local instance must never be disconnected (no safe network-isolation primitive exists for the
user's own physical machine — see below), and that invariant is easiest to guarantee by making it
structurally inexpressible in the DSL (`dsl.ts`'s `assertLocalAlwaysConnected`), backed by a
second, independent runtime assert in `execute.ts` in case the grammar-level guarantee is ever
bypassed.

**Rejected alternative: reuse node number `0` for the local instance instead of a new token.**
`dsl.ts`'s `dropRedundantNodes` already uses `active = 0` as a sentinel meaning "nothing selected
yet" — a real node `0` would collide with that sentinel, silently dropping the very first `N0`
selection in any history. This is exactly the kind of thing worth writing down here rather than
rediscovering by hitting the bug again: the collision isn't obvious from reading
`dropRedundantNodes` in isolation, only from knowing the historical reason `0` was chosen as the
sentinel in the first place.

## Real network isolation for the local node: rejected for now, not forever

Every other fault primitive in this harness (`D`/`C`) works by detaching a *container* from its
podman network — safe, because the blast radius of a mistake is a disposable container. The local
node is the user's real physical machine, so the same primitive isn't available, and the
alternatives considered so far all have real problems (framed around macOS, since that's the host
this has actually been run on so far):

- **macOS's Application Firewall (`socketfilterfw`)** — the wrong tool entirely, not just a
  slower one: it only gates *incoming* connections, and Obsidian Sync is a client-initiated
  outbound WebSocket connection (`wss://sync-xx.obsidian.md`) — blocking incoming connections to
  Obsidian does nothing to the traffic that actually needs blocking.
- **`pfctl`** — could actually work (it operates on outbound traffic), but a botched or
  interrupted rule change is host-global, not scoped to one process — unlike a podman container,
  there's no "just delete it" undo, and a stuck rule from a hard crash (not a clean exit) could
  affect the user's real networking, not just Obsidian. A narrowly-scoped anchor (blocking only
  `sync-*.obsidian.md` traffic, not a broad default-deny) plus a session-scoped sudoers grant
  (set up/torn down per soak, not a standing grant) meaningfully narrows this risk — worth
  revisiting as a real feature later, but it reverses this round's "local instance always
  connected" premise, so it needs its own design pass, not a bolt-on.
- **A macOS sandbox** (`sandbox-exec`) to run Obsidian without network access, then restart it
  outside the sandbox — process-scoped (no shared host state to leak, unlike `pfctl`), but
  Apple-deprecated with no public docs, and restarting the whole app to move it in/out of the
  sandbox is a much coarser action than a real network blip; it's unclear Sync would even treat
  an app restart as "the same device reconnecting" rather than something else, and it only gives
  one offline window per restart — doesn't compose with a `barrier`/`paced` history doing several
  D/C cycles per rep.
- **A disposable macOS VM (`tart`, Cirrus Labs)** — runs real macOS on Apple Silicon through the
  same `Virtualization.framework` the podman machine already uses for the Linux containers,
  container-like in workflow (`tart clone`/`tart run`). This removes the actual objection to
  network isolation (risk to the user's *physical* host, not a fundamental objection to isolating
  the local instance at all) — the blast radius of a mistake becomes the disposable VM, not the
  real laptop.
  Provisioning looked harder than it turned out to be: an Obsidian developer's own forum comment
  says Sync credentials live in IndexedDB inside the app's own appdata folder, not the OS
  Keychain — meaning a fresh VM likely just needs that folder copied in, not an interactive
  re-login or a Keychain export/import dance, much closer to how the container image already
  bakes in a logged-in state. Still a real, separate undertaking (its own VM lifecycle to build),
  but the biggest assumed blocker turned out not to be one.

For now: no network fault primitive for the local node at all. It's a real, always-connected
participant — `assertLocalSyncOn` (`execute.ts`) checks its Sync state before every op it
performs; a host-internet blip gets a chance to recover first (see the settle loop's own
host-outage handling), but a genuinely off Sync state aborts the whole run (not just the rep),
since it invalidates every subsequent rep until a human notices and fixes it.

## Conflict-file attribution: the title's device always matches the last token inside

Per Obsidian's own docs: the device holding a locally-differing, not-yet-synced edit is the one
that "detects" the conflict when an incoming remote update supersedes it — it adopts the remote
content as the new canonical note and stashes its OWN prior content into
`(Conflicted copy <device> <ts>)`. Since a device's own stashed content only grows via its own
sequential local appends (`A<x>` always calls `appendLine`, never `prependLine` — confirmed by
reading `execute.ts`'s op interpreter, the only call site), the LAST token inside a conflict file
is always attributable to the device named in its title.

Verified against real data, not just the docs, 2026-07-09: checked all 140 conflict files then
present in the local node's `bughunt/` folder (obsidian-cli `files`/`read`, scripted) — 140/140
matched (the device parsed from each filename equaled the writer of the last token in its
content), 0 exceptions.

This makes a lost token's expected culprit directly derivable, no guessing needed: `AckedEdit`
(`oracle.ts`) already records who wrote every token, so for a `lost` token the writer is known
for free. `execute.ts`'s `lostForensics` uses this to compute `conflictFileFound` per lost
token — whether the writer's own device left behind ANY conflict file for that note. Note it
checks for *a* conflict file from that device, not one *containing* the specific lost token: by
oracle.ts's own definition (`checkNote`), a token present in a conflict file is `onlyInConflict`,
not `lost` — a truly lost token can never appear inside any conflict file, so the presence check
has to be on the device, not the content. `conflictFileFound: false` is the clean, expected shape
of a real bug: the writer's client never even attempted to preserve its diverging edit before
silently discarding it.
