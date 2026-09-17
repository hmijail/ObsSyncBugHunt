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
unchanged IP lets the stalled connections simply resume. Re-check with `scripts/check-net.sh`, which
asserts the two properties this rests on: a container reconnected with `--ip` is reachable
essentially as soon as `network connect` returns, and a peer-to-peer TCP stream held open across the
outage resumes with its byte stream intact and no gap. If either stops holding on a future engine
version, `D`/`C` has quietly become a full network reset and the histories mean something else.

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

`W` is scoped to the **active** node: a user at that node only knows what their own client reports,
which is the whole premise of `docs/cli-trust.md`. Which node is active when the `W` runs therefore
decides what it is worth — and this bit twice, in two different ways.

**First, the placement.** The generator used to force its `TURNS=barrier` wait *after* moving the
cursor, producing `N1AaN2WAa`: n2 waits before editing. But n2 has not edited, so under the old
`synced`-only `W` it had nothing pending, so its client reported `synced` immediately — while
entirely unaware that n1's edit existed. The `W` returned as fast as the harness itself allowed.
Re-derivable from `runs/`: the **Sync latency** section of `make analyze` separates mid-history `W`s
from the final settle, and under the old placement the great majority of mid-history `W`s returned
at the mechanism's own floor while the final settle — which waits on every node for every note —
took an order of magnitude longer. They were not waiting *for* anything; they were serving out a
quiet window. Empirically `TURNS=barrier` was a short `FORCED_TURNS=P`.

This mattered beyond tidiness: soaks run under the old placement were sampling near-unpaced
hand-offs with an incidental few-second delay, not the barrier their history strings implied, so
losses found there came from a more aggressive regime than the `W`s suggested.

Hence `FORCED_TURNS` is now emitted **before** the cursor moves, so it runs on the node that just
edited: `N1AaWN2Aa`. That is the glance at the sync indicator a user really takes before picking up
another device.

**Second, the mechanism.** The redesigned `W` closes the same hole from the other side, and would
have survived the bad placement. It waits for *every* acked token for the note — from every node
that is not disconnected, not merely the active node's own writes (`expected` at the call site in
`execute.ts`) — to be present on the active node's filesystem, with `synced` and a server-counter
advance as corroboration. So a `W` on a node that has not written no longer returns instantly: it
now has n1's tokens to wait for. The placement fix and the mechanism fix are independent, and both
are worth keeping — the placement is what makes the history string mean what it says, and the
mechanism is what makes `W` a barrier at all.

Note what is deliberately *not* fixed. `W` still ends on the active node's own view, so it remains a
self-report, blind spot and all. That is the point: the interesting question is not "wait until it
is safe" but "wait until Obsidian says it is safe", and the gap between those is where the bug
lives. What the redesign removed was a `W` that did not even manage to be that.

### The settle floor is the harness's paranoia, not a user model

**Historical note, kept because it explains a redesign.** `W` used to mean "wait until the observed
state has read `synced` unchanged for `wSettleSec` (default 4)" — a window, not a barrier, because a
single `synced` reading can be transient and sampling mid-flux is how the harness would fabricate
verdicts. `minFloorSec` (default 3) sat underneath it for the same kind of reason, so the effective
floor was a few seconds and `W` could not be tuned below it.

That is no longer what `W` does. `wSettleSec` and `--w-settle-sec` are **gone**: `W` now waits for
the expected tokens to be on the active node's filesystem *and* for Obsidian there to report
`synced`, corroborated by the server version counter advancing past a pre-write baseline. It has no
window and no floor — it ends when the data is demonstrably there, or, as `W<n>`, when the history's
own stated patience runs out.

The settle machinery survives, but only in one place: the **final** convergence check at the end of
a rep (`waitForSynced`, `--final-settle-sec`, with `--min-floor-sec` still guarding the
just-after-connect gap before a sync has started). That is a different question — "has everything
converged?" rather than "may this user proceed?" — and a quiescence window is the right instrument
for it.

## The server version counter cannot see a pending sync

`sync:history file=<n> total` gives a server-side count of versions for a note. It is tempting as a
signal the *user* does not have: if it rose while a node still lacked the content, the harness could
tell that a sync was in flight — catching the case of a user who waited, gave up, and edited anyway.

It cannot. Re-check with `npm run probe-sync-versions`, which establishes each of these:

- a node's total **never leads its own content** — it rises in the same poll the token appears,
  never before, on the reading node and on the writing node alike
- the **writing** node's own total does not count its own edit while its own upload is still in
  flight — it answers with its pre-upload count, promptly, so not even the node's own pending sync
  is visible in it. (The probe has two nodes and sees the writer's total and the peer's content flip
  in the same poll, so it does *not* establish which of the two the refresh actually waits on —
  the server committing, or the peer pulling. Only "not while my own upload is pending" is measured.)
- a real partition and reconnect changes none of that: counter and content still flip together

The counter is a *cached local* view of server history, refreshed when the node syncs — not a live
reading of the server.

Note what that does and does not say. The gap is real: n1 holds an edit n2 lacks, for seconds at a
time. What is invisible is the counter moving. So this is not "Obsidian syncs so promptly that no gap
opens" — the gap is plainly there in the probe's output — it is "the number only refreshes when the
client syncs, so a sync in flight looks exactly like idle". The name is part of the confusion: it is neither a version
*number* nor a *server* reading, but a per-node cached count.

Either way it offers no lead time over simply reading the file, and neither of the interesting uses
is available: a wait cannot be made to honour it (it says nothing the content does not), and a "you
gave up while a sync was pending" detector cannot be built on it.

What it does support is what it is already used for: `total < 1` means a note never reached the
server at all, which is `-NOUPLOAD`. That remains a hidden signal reaching a verdict, deliberately —
it catches a note living on exactly one device, a durability failure the user cannot see.

### The long blocks are real — but the code names the wrong cause

`execute.ts` reads the baseline lazily because `sync:history total` "blocks until the queried node
has **caught up**", and `driver.ts` bounds each attempt against reads that "can silently block for a
long time". The blocking is real. The stated cause is not.

**All of this is about `sync:history`.** `sync:status` blocks for its own reasons, described at the
end of this section, and the two must not be generalised into one rule about "the `sync:*` calls".

For `sync:history`: a node that is merely behind answers promptly — every call in the probe's steps
1-6 comes back in the normal range, including the first on a just-reconnected node with a version
still pending. What actually blocks is a node with **no network at all**, which the probe's step 7
exercises. Its output shows the three phases in order:

1. **early attempts are killed at the per-attempt cap** — genuine blocking, the client still
   believes it can reach the server
2. **one attempt fails with an internal error** —
   `Failed to retrieve sync history: Cannot read properties of null (reading 'send')`
3. **every later attempt returns immediately** with a recognizable refusal —
   `Error: Sync is in error state. Check sync settings.`

So the client hangs while it still hopes, throws an internal error as it gives up, and only then
starts answering promptly. The cost is concentrated entirely in phase 1, which is why the bound has
to be per attempt: the phase that blocks is the phase that ends on its own.

The lazy baseline therefore protects correctly, but by accident: it is gated on `everySynced`, and
neither a disconnected node nor a still-syncing one can report `synced`. Worth knowing before anyone
simplifies that gate away on the grounds that catching up is fast: for `sync:history` it is, but the
gate is not what makes that safe.

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

It also explains the shape of the defences: `RECOGNIZE_CALL_TIMEOUT_MS` turns phase 1's hangs into a
visible retry sequence instead of one long silent stall — which is why the probe's output shows the
phases at all, rather than a single opaque wait.

#### `sync:status` blocks on a different condition — being mid-sync, network or not

`sync:status` returns promptly only when the node is `synced`. While it is *syncing* it blocks, and
that is independent of whether the node has a network right now: a node that has just reconnected,
is reachable, and is working through its backlog blocks exactly the same way one with no network
does. So "does it have a link?" does not predict this call, and the rule above — that only a
network-less node blocks — must not be carried over to it.

Seen in an ordinary rep of `N2DN1AaWN2AaP30`: n2's reconnect was confirmed reachable, and its
`sync:status` was then killed at the probe cap on three consecutive settle polls before answering
`syncing` normally. Because the settle probes every node in parallel and waits for the slowest, each
of those polls cost the full cap plus the poll interval while reading nothing — `gatherMs: 0`, since
content is only read once every node reports `synced`.

Nothing bounds it but the caller: `syncStateProbe` takes a timeout and reports `timeout` rather than
a state, which is what keeps a settle polling instead of hanging. Lowering `PROBE_SEC` does not
recover the time — it times out sooner and polls more often for the same total wait, because the
wait is the node's, not the harness's.

No check re-establishes this one. `npm run probe-sync-versions` exercises the disconnected case
(step 7) and would be the place to add a reconnected-and-syncing measurement if it is ever worth
pinning down.

### Taking the baseline must not widen the gap it measures

`W` compares the counter against a pre-write baseline, and the first version of that read it on
**every** node before **every** append. On `N1AaN2Aa` — two appends that are supposed to race — that
put a `sync:history` round on each node squarely between them: the two writes went out ~300ms apart
instead of ~70ms, n1's note reached n2 inside the gap, n2's append was logged `created: false`, and
the run converged with no conflict file. The same history under `make repro`, which has no such read,
produces one every time. The harness was suppressing the bug it was built to find.

Three facts make the read nearly free instead, and none of them cost observability — every node's
baseline is still logged as a `sample` on every append:

- **The writing node's read rides in its own write batch** (`editAndConfirm`'s `versionsMs`), one
  statement of the same `sh -c` ahead of the append. No extra round trip, and no interval between
  the read and the write for anything to happen in — a stronger ordering than a separate call can
  offer, so it does not lean on how fast the counter refreshes.
- **Nobody else re-reads.** A baseline is not "the counter lately", it is "the counter before the
  write *this* node is waiting to see confirmed", so refreshing it when a *different* node appends
  can only replace a correct pre-write value with one that may already count the write. That refresh
  was the expensive half: ~230ms on n1, the node whose value was already right, against ~80ms on n2.
  The asymmetry is the "not found answers in milliseconds" rule above — n1 had history for the note,
  n2 had none.
- **At a note's genesis the answer is known.** Vault names carry the rep id, so before anything has
  tried to write the note no node can hold server history for it: every baseline is `null`. It is
  recorded as such rather than spending an exec per node to confirm a certainty, on the one op where
  the harness is trying hardest to stay out of the way.

  It is *recorded*, not left unset, because those are different things to `W`: a missing key means
  the counter could not be read, and `W` drops counter corroboration entirely, while `null` means the
  server genuinely had no history, so any later reading counts as movement. The sample is logged with
  `inferred: true` so the log does not claim a measurement that was never taken.

`N1AaN2Aa` now issues **no standalone `sync:history` at all**.

A probe placed between two operations is part of the experiment. Anything read on the write path has
to be free, or ride along with something already being sent.

### `N1AaN2Aa` should produce a conflict file

Two appends to a note that does not exist yet, one per node, back to back. The project's cheapest
real divergence: no partition, nothing forced, just two clients creating the same path before either
has heard of the other. Re-check with `make check-assumptions` (step 10), which runs it three times.

**The assertion is the conflict file.** If it stops appearing, either the harness slowed down
between the two appends or Obsidian's behaviour moved; both need looking at.

`created` on the two appends is the discriminator that says which failure it is, not the assertion.
It is not sufficient on its own: across 53 reps in `runs/`, `created: [true, true]` has produced all
three of a conflict file, a clean merge, and a lost token.

| what the rep shows | reading |
|---|---|
| `created` not both true | the appends were too far apart; the second node appended to a note that had already arrived, so there was no divergence |
| both created, a conflict file | the intended outcome |
| both created, no conflict file, a token missing | a divergence dropped data — possibly a real Obsidian bug rather than an apparatus fault |
| both created, no conflict file, nothing missing | the two creates merged; see the conflict-file mode check |

**The gap is diagnosis, not an assertion.** Over those 53 reps it conflicted at ≤369ms 33 times out
of 34 and never at ≥388ms, so there is a boundary around 370–390ms — but near it the outcome is a
distribution, because the gap competes with the propagation of a create rather than with a constant
(`make probe-propagation` gives that distribution). Both exceptions inside the fast range were
losses, not slow reps, which is the other reason not to assert a threshold: the interesting failure
lives inside the range where the assertion would have passed.

What the harness controls is its own share of the gap, and only part of it. The second node's write
is two round trips — `append` to find out whether the note has arrived, then `create` — and that is
irreducible, because whether it arrived is exactly the question being asked. The rest is the round
trip itself, which is not the harness's to fix: measured on the same machine hours apart, an empty
`docker exec` moved from ~65ms to a median of 135ms, and the gap moved from ~150ms to ~350ms with
the code unchanged. `make bench-cli` is the check that tells those two apart.

The sampling modes cannot affect this history: `sampleAll` is passed only to the `W` handler and the
closing settle, and `N1AaN2Aa` has no `W`, so nothing samples between the two appends. Measured at
4/4 conflict files under `SAMPLING=everything-no-sleep`. "The `everything` modes perturb what they
measure" applies inside a wait.

#### Open: two creates that merged

Four reps diverged and then merged rather than conflicting — both nodes `created: true`, both tokens
in the canonical (`"(n1-1-a)\n(n2-2-a)"`), no conflict file, verdict ok — while the conflict-file
mode check passes. All four had wide gaps: `07T002643-N1AaN2Aa/07T002912` (488ms), `07T004304-N1AaN2Aa/07T004322`
(495ms), `07T002643-N1AaN2Aa/07T002757` (583ms), `/07T002720` (597ms). Unexplained. Step 10 reports
this case separately rather than folding it into "no conflict file".

## Creating a note and editing one are not the same operation

Re-check with `make probe-propagation`, which times each write until BOTH nodes show it, and with
the **Sync latency** section of `runs/analysis.md` (`make analyze`), which reports the same
distributions over every recorded run. Two properties, both of which have held every time they have
been looked at:

- **creates land about an order of magnitude faster than edits**, with no overlap between the two
  distributions — the slowest create still beats the fastest edit
- **the edit figure barely moves**, clamping tightly just under a round number of seconds. Network
  latency or server load would spread it; a tight clamp looks like a fixed internal cycle rather
  than a transfer.

Two things follow.

**This is why `W` was redesigned.** The old `W` returned at its settle floor of a few seconds while
the edit it was nominally waiting for landed at around ten. So a barrier hand-off did not
*sometimes* race the sync — it was beaten every time, by more than its own floor, which is the
mechanism behind mild turn-taking histories like `N1AaWN2AaW…` losing data so readily. A floor
shorter than the thing it is waiting for is not a barrier at all. The token-aware `W` above removes
that particular mechanism by construction; **whether the losses go with it is an empirical question,
and the corpus is how to answer it** — `make analyze` breaks the loss rate down by where the `W`
sits.

**Every history's first edit is special.** Without a fixed opening, a generated history spends its
first append in the fast create path and the rest in the slow edit path — two regimes in one
experiment. `PREFIX=N1AaWN2PW` exists for this: it creates and settles a note on both nodes before
the generated part starts, so what follows is uniformly the edit case. Prefix appends deliberately do
not count toward `OPS`, which is the size of the experiment, not of its setup.

A prediction worth testing, and cheap: `FORCED_TURNS=P12W` should collapse the failure rate of those
histories, because the pause outlasts propagation before the `W` even looks. Note the right
way to test it is the forced turn, NOT a global patience knob. A knob changes what every `W` means
while the recorded string still says `W`, silently reclassifying stored histories; `P12W` puts the
change in the artifact where a reader can see it. This is also why `W<n>` carries its patience in
the history string rather than in a flag — the same principle, applied at the point where the old
`--w-settle-sec` got it wrong.

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

## A loss has two severities, and the milder one is still invisible to the user

When the oracle declares a token `lost`, `lostForensics` (execute.ts) asks a second question: is it
still in the note's **server-side version history**? It reads `sync:history` for the count and
`sync:read <note> <v>` for each version, and splits the losses two ways. Re-check by reading any
`-LOST` rep's `forensics`, or the per-history line in `runs/analysis.md`.

| reported as | means |
|---|---|
| `in-server` | the token is still in server version history, though it is in no node's note and in no conflict copy. Recoverable by hand through Obsidian's version history |
| `not-in-server` | the token is in no server version at all. Acked locally, never reached the server. The worse of the two |

The field is `inServer`; the labels appear in the per-rep failure line from `make run`/`make soak`
and in each history's line in `analysis.md`.

**`in-server` is the milder classification but it is not a near-miss.** No device shows the token and
no conflict file flags it, so a real user has nothing to react to: the only route back is knowing to
open version history on a note that looks perfectly fine. Both classes are data loss from where the
user sits; they differ in whether anything can be done about it afterwards.

Worth knowing when reading the split: the labels used to be `server-dropped` and `never-registered`,
which read backwards — "server-dropped" sounds like the server lost it, i.e. the worse case, when it
means the server still HAS it. Renamed 2026-09-07. Reps written before then do not carry `inServer`
at all and `analyze` reports them under "Could not be read" rather than guessing a side; see the
no-back-compat rule in that file's header.

## Conflict-file attribution: the title names the device that produced the file

Per Obsidian's docs (`obsidian.md/help/sync/troubleshoot`, Conflict resolution): one device detects
the conflict, puts its own local contents into the conflict file, puts the remote contents into the
real note, and names the conflict file after itself. "The conflict file contains the changes from
the device where the conflict was detected. The original file keeps the remote version."

That single actor doing all three is the whole model, and it is all the harness needs: a conflict
file is attributable to the device named in its title. `oracle.ts` parses that name and checks it is
a known node (`wellFormed`); `execute.ts`'s `lostForensics` uses the set of those names to compute
`conflictFileFound` per lost token — whether the writer's own device left behind ANY conflict file
for that note.

Note it checks for *a* conflict file from that device, not one *containing* the specific lost token.
By `oracle.ts`'s own definition (`checkNote`), a token present in a conflict file is
`onlyInConflict`, not `lost` — a truly lost token can never appear inside any conflict file, so the
presence check has to be on the device, not the content. `conflictFileFound: false` is the clean,
expected shape of a real bug: the writer's client never even attempted to preserve its diverging
edit before silently discarding it.

### The stronger "last token matches the title" claim: sound, but unused

This document also carries a stronger claim — that the LAST token inside a conflict file is
attributable to the device named in its title — and it does hold, for a reason that is worth writing
down because it is a **configuration** property, not a property of Obsidian in general.

Every node is set up with Sync's **"create conflict file"** option on (README's VNC setup step). In
that mode Obsidian does not merge divergent copies: on conflict it stashes and replaces. So a
device's local content is only ever its fast-forwarded base plus its OWN subsequent appends —
another node's token can enter the base by fast-forward, but never *after* this device's local
appends, because there is no merge step to interleave it. Since a device that detected a conflict
had at least one local append, the last token is its own. `editAndConfirm` being append-only
(above) is the other half.

**Do not restate this as a fact about Obsidian.** It is a fact about Obsidian *configured this way*.
Under the merge setting the same reasoning fails outright: a merged-in remote token could land last
in a file titled for the other node. `oracle.ts` is deliberately written to survive that — the token
oracle is the correctness gate and `conflictMeta` is informational, which is what its "auto-merge is
legal" comment means. That comment is about the oracle tolerating a mode we do not run, not about
what happens in the mode we do.

**Nothing currently uses the claim.** `conflictFileFound` is computed from filenames alone;
`lostForensics` never reads a conflict file's content, and no verdict or `analyze.ts` section
consumes a last-token rule. So it is presently inert: worth keeping recorded, since it is the kind
of thing a future forensic would want, but not worth building a checker for until something reads
it. It was verified once by a one-off script over every conflict file then on disk, with no
exceptions; that script is gone.

**The softer spot is upstream of it.** Conflict-file mode is a manual per-node VNC setting that
nothing in the harness verifies at runtime. A node brought up without it would merge instead of
producing conflict files — and the oracle, by design, would not fail: merged content loses no
tokens. The run would simply be a different experiment than its label claims, silently, which is the
exact shape `scripts/check-assumptions.sh` exists to catch. Detecting it means forcing a conflict
and asserting a file appears, not reading a setting.

## The container round trip is the entire cost of a CLI call

Re-check with `make bench-cli`. It prints current numbers; this section deliberately records none,
because a table copied in here goes stale silently and invites exactly the false precision the
benchmark spent so long learning to avoid.

**A note operation costs essentially nothing beyond the round trip.** `read`, `files`, `create` and
`append` all measure the same as an *empty* `<engine> exec true`, and timed INSIDE the container they
are a couple of milliseconds. The transport is the cost, which means **cutting calls is the only
lever** — a faster Obsidian would change nothing.

**The exception is `sync:status` and `sync:history`,** which are several times more expensive and
whose cost is real work, not transport: timed inside the container they still cost most of what they
cost outside. They interrogate Sync rather than the vault, and nothing on disk can answer them, so
they cannot be avoided by reading the filesystem.

**Reading the filesystem directly is not CHEAPER — which is a different claim from useless.** `cat`
matches `read` and `ls` matches `files`, because both are one exec and the exec is the cost. So the
FS is no way to speed the harness up.

It is, however, the harness's second witness, and both cross-checks at the settled verdict are built
on it: `crossCheckFs` (`ls` vs `files`, which files exist) and `crossCheckContent` (`cat` vs `read`,
what is in them). The CLI reports what Obsidian believes and the filesystem what is on disk, and the
gap between the two is a thing this harness exists to detect — see docs/cli-trust.md. Being
same-priced is what makes that affordable: the content check costs about one round trip per file.

Both checks log a `cross-check` line carrying what they compared and the `ms` it took, whether or
not they found a disagreement — so their cost is re-measurable from any rep's own log rather than
quoted here from a run nobody can repeat. Every logged line that reports observed data carries its
own `ms` on the same principle.

### How the calls are issued: only one arrangement is bad

Three independent choices for the four calls a sampling round makes: **sequential or parallel**, **one
exec or one each**, and **obsidian-cli or the filesystem**. `make bench-cli` measures all eight cells
plus two identical control rows.

**`unbatched + sequential` is roughly twice everything else**, because it pays the exec overhead once
per call end to end. Every other cell lands within the run's own noise floor of a row that ran a
literally identical command — which the benchmark states per row (`=` / `*`) and summarises in its
footer, so you never have to take a remembered number on trust.

Two things follow that are worth knowing but not worth tuning on: parallelism *inside* a single exec
is not a win (Obsidian serialises the IPC, so concurrency only moves the queue), and the ordering
among the fast cells changes between runs. Any ranking of them is reading scatter.

### What the two code paths use, and why

| path | arrangement | why |
|---|---|---|
| the sampler (`ObsidianDriver.sampleNotes`) | unbatched, parallel, CLI | its four calls are independent, so parallel is available and keeps it out of the slow cell. Separate execs also give each call its own timeout for free, which the bounded sampler needs. |
| the write path (`ObsidianDriver.editAndConfirm`) | batched, sequential, CLI | a dependency chain — append, then read back to confirm it landed — so sequential is forced, not chosen. Batching is what keeps a forced-sequential path out of the one slow cell. |

They sit on opposite corners of the matrix without conflicting, because the two axes answer different
questions: **whether the calls depend on each other decides sequential-vs-parallel, and batching only
matters once you are stuck with sequential.**

The write path's arrangement is the same cell the benchmark's control rows use, so it is measured
directly on every run rather than argued about.

### Append before create, never the reverse

Two undocumented CLI behaviours, measured the same day, decide the order of the write path:

- `append` to a note this node does not have **errors** — `Error: File "..." not found.` It does not
  silently no-op, as a comment in `execute.ts` claimed for a long time. Because the failure is
  positively reported, the write path can try `append` first and create only on that reply, with no
  speculative read in front of it.
- `create` on a note that already exists neither fails nor overwrites: it makes a **numbered
  sibling**, `<note> 1.md`, and leaves the original alone.

So guessing wrong toward `append` costs one extra round trip; guessing wrong toward `create` leaves a
file in the vault that the oracle never accounted for. The order follows.

**The one case where it is not a guess** is a note's genesis: nothing has tried to write it anywhere,
so it exists nowhere, so `append` is certain to come back "not found". That write goes straight to
`create` — one round trip instead of two, at exactly the moment that decides whether two nodes create
the same note independently or one merely appends to what the other already made. Only on the first
attempt; a retry is there precisely because an earlier write may have landed unseen, so it reverts to
append-first. Every later write still pays the probe, and there is no way around it — whether the
note has arrived yet is the question being asked. Doing it as `append || create` inside the batch's
shell was considered and rejected: deciding "not found" would mean reimplementing a CLI-output parser
in `sh`, and a skipped command leaves no output to split the batch on, both of which
`docs/cli-trust.md` exists to prevent. Both are checked by
`make check-assumptions` (step 8), because an upgrade could change either without warning: if
`append` ever auto-created, the fallback would stop firing, every creation would be logged
`created: false`, and the create-create conflict-genesis signal would quietly become worthless
without a single test failing.
