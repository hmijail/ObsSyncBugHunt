// Fault primitive: a clean offline window for a node.
//
// For Obsidian Sync the meaningful "offline" is "can't reach the cloud while
// still running" (a quit node can't make CLI edits). We detach the whole
// container from its container network, then reattach — an authentic offline
// window, no privileged networking required.

import { connectPinsMac, engineBin } from "./engine.js";
import { runProcess } from "./exec.js";
import type { ObsidianDriver } from "./driver.js";
import type { NodeId } from "./types.js";

export interface Isolator {
  disconnect(node: NodeId): Promise<void>;
  connect(node: NodeId): Promise<void>;
  /** Optional per-rep sink for internal-step events (set to RunLogger.log); else console.
   *  Only `NetworkIsolator` currently emits anything — its internal reachability-poll retries. */
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Preferred fault primitive: Obsidian's own `sync off` / `sync on`. CLI-native,
 * deterministic, keeps the app running so edits still work, and is literally the
 * "pause sync" feature a user would use. No network/engine manipulation.
 */
export class SyncToggleIsolator implements Isolator {
  constructor(private readonly drivers: Map<NodeId, ObsidianDriver>) {}

  private driver(node: NodeId): ObsidianDriver {
    const d = this.drivers.get(node);
    if (!d) throw new Error(`no driver registered for node ${node}`);
    return d;
  }

  async disconnect(node: NodeId): Promise<void> {
    const r = await this.driver(node).syncPause();
    if (!r.ok) throw new Error(`sync off ${node}: ${r.error}`);
  }

  async connect(node: NodeId): Promise<void> {
    const r = await this.driver(node).syncResume();
    if (!r.ok) throw new Error(`sync on ${node}: ${r.error}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Thrown when the ENVIRONMENT stops satisfying something the harness's experimental design rests
 * on — as opposed to `CliInconsistencyError`, which is the black box under test behaving oddly.
 *
 * The distinction decides what happens next, which is why these are separate classes. A CLI
 * inconsistency is a possible *result* of a rep: it gets tagged (-OBSFAIL/-UNKNOWN) and the soak
 * carries on, because the next rep is still a valid experiment. A violated environment assumption
 * is not a result at all — it means the apparatus is no longer doing what the histories say it
 * does, so every subsequent rep would be equally meaningless. It is FATAL: `runRep` tags the rep
 * and rethrows, and the run stops (see run.ts).
 *
 * `remedy` is printed to the operator verbatim, so it should say what to actually do.
 */
export class EnvironmentAssumptionError extends Error {
  constructor(
    readonly assumption: string,
    readonly remedy: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`environment assumption violated: ${assumption}`);
    this.name = "EnvironmentAssumptionError";
  }
}

// Pinned per-node network identity, so a reconnect restores the EXACT same IP/MAC the
// container had before (and from its very first `containers-up` — see the Makefile) rather
// than a fresh dynamically-assigned one — see docs/DESIGN.md for why, and for the story behind
// the MAC address's first byte specifically.
// Node number comes from the trailing digits of its name (n1 -> 1, n2 -> 2); X = 100 + number.
// IP = 10.89.0.<X>. The Makefile's `net` target creates obsidian-net with an explicit
// `--subnet 10.89.0.0/24` so this holds on any engine — it used to be merely Podman's default,
// which silently made these addresses unassignable under Docker (default 172.x).
// MAC = 6e:62:6e:65:74:<X in hex>. The first byte (0x6e = 'n') MUST keep its I/G bit (least
// significant bit of the first byte) at 0 — a real interface MAC must be unicast, not
// multicast — and its U/L bit at 1 (locally-administered, since this isn't vendor-assigned).
// Only the first byte carries this constraint; the rest is free, but must stay valid 2-digit hex
// (e.g. X=101 -> "65", not the invalid 3-char decimal "101").
export function nodeAddress(node: NodeId): { ip: string; mac: string } {
  const m = /(\d+)$/.exec(node);
  if (!m) throw new Error(`can't derive a node number from "${node}" for IP/MAC pinning`);
  const x = 100 + Number(m[1]);
  if (x > 255) throw new Error(`node number too large for a single address byte: ${node} -> ${x}`);
  return { ip: `10.89.0.${x}`, mac: `6e:62:6e:65:74:${x.toString(16).padStart(2, "0")}` };
}

/**
 * Detach/attach a container from its container network — the real "device goes
 * offline" fault. We don't trust the command to take effect instantly (an
 * in-flight sync can keep draining); instead we BLOCK until the container's own
 * connectivity confirms it, with a TCP reachability probe to a well-known numeric
 * endpoint (8.8.8.8:53 — no DNS): disconnect waits until it's unreachable, connect
 * until reachable. (TCP, not ping: rootless podman blocks ICMP — no raw socket.)
 * This is a pure network-state check, independent of what Obsidian does about it.
 */
export class NetworkIsolator implements Isolator {
  onEvent?: (event: Record<string, unknown>) => void;
  /** Delay between reachability polls; overridable so tests don't wait real time. */
  pollDelayMs = 500;
  /**
   * How long a reconnect may take before the run is ABORTED.
   *
   * A `D`/`C` pair is meant to be a brief LINK BLIP — the node's established connections to Sync
   * stall and then resume, because its IP is re-pinned. If reconnection instead takes seconds,
   * those connections have died on timeout and Obsidian is running its rejoin/error-recovery
   * path. That is a different experiment from the one the history describes.
   *
   * Hence fatal, not merely logged. The tempting alternative — record it and carry on, the way a
   * host-outage detour is handled — is wrong, because this isn't a transient blip that spoils one
   * rep's timings: it means the fault primitive itself is broken, so every following rep in the
   * soak is equally meaningless. A run that keeps going is a run quietly manufacturing results
   * about the wrong experiment. Stopping points at what actually needs fixing — the container
   * networking — instead of burying it in a JSONL nobody reads until morning.
   *
   * Whether this holds is a property of container-engine INTERNALS, which change under you: it
   * was verified on Docker 29.7.2 at ~60ms, i.e. ~16x under this budget. `make net-check` and
   * `make check-assumptions` measure it deliberately on a disposable container (a history with no
   * `D` never exercises it at all); this is the always-on guard riding on every real `C`.
   *
   * The number compared here is coarser than net-check's — it includes the engine-exec cost of
   * the probe itself, so a healthy reconnect still reports a few hundred ms — which is why the
   * budget is a full second rather than the ~60ms a bare reconnect actually takes. Raise it with
   * `--reconnect-budget-ms` / `make ... RECONNECT_BUDGET_MS=...` on a slow machine.
   */
  reconnectBudgetMs = 1_000;

  constructor(
    private readonly network: string,
    private readonly host = "8.8.8.8",
    private readonly port = 53,
    private readonly capMs = 30_000,
    // Test seam: overrides the real TCP-probe call. Unset (production default) = real behavior.
    private readonly probeFn?: (node: NodeId) => Promise<boolean>,
  ) {}

  private emit(event: Record<string, unknown>): void {
    if (this.onEvent) this.onEvent(event);
    else console.warn(`· ${JSON.stringify(event)}`);
  }

  private async reachable(node: NodeId): Promise<boolean> {
    if (this.probeFn) return this.probeFn(node);
    const r = await runProcess(engineBin(), [
      "exec", node, "timeout", "2", "bash", "-c", `echo > /dev/tcp/${this.host}/${this.port}`,
    ]);
    return r.code === 0;
  }

  /** Poll `reachable()` (probe first, sleep last — never the other way round) until it matches
   *  `want`. EVERY attempt is logged, including the one that finally confirms — the internal step
   *  needs to be visible even when it succeeds on the very first try (the common case in practice:
   *  the engine's network toggle takes effect near-instantly, so without this, "log internal steps"
   *  produced zero events in every real run). */
  private async waitReach(node: NodeId, want: boolean, label: string): Promise<number> {
    const start = Date.now();
    const deadline = start + this.capMs;
    for (let attempt = 1; ; attempt++) {
      const got = await this.reachable(node);
      const elapsedMs = Date.now() - start;
      this.emit({ kind: "network-probe", node, label, want, reachable: got, attempt, elapsedMs });
      if (got === want) return elapsedMs;
      if (Date.now() > deadline) {
        throw new Error(`${label} ${node}: ${this.host}:${this.port} ${want ? "still unreachable" : "still reachable"} after ${this.capMs / 1000}s`);
      }
      await sleep(this.pollDelayMs);
    }
  }

  async disconnect(node: NodeId): Promise<void> {
    // Ignore command errors (e.g. already disconnected) — reachability is the truth.
    await runProcess(engineBin(), ["network", "disconnect", this.network, node]);
    await this.waitReach(node, false, "disconnect");
  }

  async connect(node: NodeId): Promise<void> {
    const { ip, mac } = nodeAddress(node);
    // The IP is re-pinned on every engine; the MAC only where `network connect` can do it
    // (Podman yes, Docker no — see engine.ts's connectPinsMac). Emitted rather than assumed,
    // so a rep's log says which of the two identities actually survived its reconnect.
    const pinsMac = await connectPinsMac();
    const macArgs = pinsMac ? ["--mac-address", mac] : [];
    this.emit({ kind: "network-identity", node, ip, mac: pinsMac ? mac : null, macPinned: pinsMac });
    await runProcess(engineBin(), ["network", "connect", "--ip", ip, ...macArgs, this.network, node]);
    const reconnectMs = await this.waitReach(node, true, "connect");
    this.enforceBlipBudget(node, reconnectMs, { ip, macPinned: pinsMac });
  }

  /** The budget decision, split out from `connect()` so it can be unit-tested without a real
   *  engine call (`connect` shells out twice before reaching it). See `reconnectBudgetMs`. */
  private enforceBlipBudget(node: NodeId, reconnectMs: number, detail: Record<string, unknown>): void {
    if (reconnectMs <= this.reconnectBudgetMs) return;
    // Emitted BEFORE throwing, so the measurement survives in the rep's own JSONL trace: the
    // throw aborts the run, but the forensics stay on disk.
    this.emit({ kind: "slow-reconnect", node, reconnectMs, budgetMs: this.reconnectBudgetMs });
    throw new EnvironmentAssumptionError(
      `reconnecting ${node} took ${reconnectMs}ms, over the ${this.reconnectBudgetMs}ms blip budget`,
      "A D/C is supposed to be a brief link blip (connections stall, then resume), not a network reset.\n" +
      "  This slow, the node's connections to Sync will have died on timeout and Obsidian took its\n" +
      "  rejoin path instead — the histories no longer test what they say, so the run stopped.\n" +
      "  Diagnose with:  make check-assumptions   (or just: make net-check)\n" +
      "  Background:     docs/DESIGN.md, \"Network identity\"\n" +
      "  If this machine is simply slow, raise the budget: make ... RECONNECT_BUDGET_MS=2000",
      { node, reconnectMs, budgetMs: this.reconnectBudgetMs, ...detail },
    );
  }
}

/** No-op for local single-machine dev where real isolation isn't possible. */
export class NoopIsolator implements Isolator {
  async disconnect(node: NodeId): Promise<void> {
    console.warn(`[noop-isolator] would disconnect ${node}`);
  }
  async connect(node: NodeId): Promise<void> {
    console.warn(`[noop-isolator] would connect ${node}`);
  }
}
