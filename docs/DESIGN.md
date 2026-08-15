# Design decisions and dead ends

Broader architectural narrative that doesn't fit `docs/cli-trust.md`'s CLI-output-trust theme —
why things are shaped the way they are, and paths considered and rejected. Like `cli-trust.md`,
this is a record of reasoning, not a spec: when the black box it's reasoning about changes (a new
Obsidian version, a new podman/Docker release), the conclusions here may need resampling. What
should stay true regardless is the general ethos this repo follows — verify everything through an
explicitly recognizable path, log every step, fail hard on the unknown.

Where a conclusion here is load-bearing enough that its silent expiry would corrupt results
rather than merely break something, it gets an executable check instead of a paragraph — see
`make net-check` under "Network identity" below.

## Network identity: pinning the same IP/MAC across reconnects

`isolate.ts`'s `nodeAddress()` derives a fixed IP and MAC address per node (`n1` → `10.89.0.101`
/ `6e:62:6e:65:74:65`, etc.) and re-applies it on every reconnect, rather than letting the engine
assign a fresh one each time.

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
`scripts/net-check.sh`): a container reconnected with `--ip` was reachable again within ~50ms of
the `network connect` command returning, and a peer-to-peer TCP stream held open across a 10s
outage resumed with its byte stream intact and no gap.

The **MAC** turns out not to be load-bearing for that goal, which is fortunate, because Docker
cannot re-pin it: `docker network connect` has no `--mac-address` flag, and the plausible
`--driver-opt com.docker.network.endpoint.{mac_address,macaddress,mac-address}` spellings are all
accepted silently (exit 0) while a fresh random MAC is assigned anyway. Podman can, and still
does. The reason losing it costs nothing: disconnecting destroys the container's interface, which
takes its ARP cache with it, so on reconnect the node must re-ARP for its gateway — and that ARP
request carries the new MAC, updating the peer's neighbour entry immediately. There is no stale-
ARP blackhole to wait out. The MAC is therefore pinned where the engine supports it (recorded per
reconnect in the `network-identity` event, `macPinned: true|false`) and skipped where it doesn't.

**This is an assumption about engine internals, so it is checked rather than trusted.**
`make net-check` (`scripts/net-check.sh`) measures it deliberately on a disposable container —
reconnect latency against a budget (default 1s) plus a hard assertion that the pinned IP survived
— and is the thing to run after installing, switching, or upgrading a container engine. The same
budget rides along on every real `C` at runtime: `NetworkIsolator.reconnectBudgetMs`, which emits
a `slow-reconnect` event into the rep's own trace when exceeded, rather than aborting (a slow
reconnect is an environment problem, and failing the rep would misreport infrastructure as an
Obsidian finding).

The MAC address's first byte is `0x6e` ('n', for "nbnet") rather than the more on-the-nose `0x6f`
('o', for "obnet") for a real constraint, not a spelling preference: a MAC address's first byte's
least-significant bit is the I/G (individual/group) bit — 0 for a normal unicast address, 1 for
multicast — and `0x6f` has that bit set. (This still matters wherever the MAC *is* pinned, i.e.
podman and `<engine> run` on both.) Podman's rootless network backend (netavark) refuses to
assign a multicast address to a real interface, confirmed live (`Error: netavark: create veth
pair: Netlink error: Cannot assign requested address`) before switching to `0x6e`, which also has
the U/L (locally-administered) bit set — correct for a made-up, non-vendor-assigned address. Only
the first byte carries this constraint; the rest of the address is free to be anything (subject to
staying valid hex, since the last byte encodes the node number and must stay a 2-hex-digit value).

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
