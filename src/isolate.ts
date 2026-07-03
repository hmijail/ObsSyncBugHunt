// Fault primitive: a clean offline window for a node.
//
// For Obsidian Sync the meaningful "offline" is "can't reach the cloud while
// still running" (a quit node can't make CLI edits). We detach the whole
// container from its Podman network, then reattach — an authentic offline
// window, no privileged networking required.

import { runProcess } from "./exec.js";
import type { ObsidianDriver } from "./driver.js";
import type { NodeId } from "./types.js";

export interface Isolator {
  disconnect(node: NodeId): Promise<void>;
  connect(node: NodeId): Promise<void>;
  /** Optional per-rep sink for internal-step events (set to RunLogger.log); else console.
   *  Only `PodmanIsolator` currently emits anything — its internal reachability-poll retries. */
  onEvent?: (event: Record<string, unknown>) => void;
}

/**
 * Preferred fault primitive: Obsidian's own `sync off` / `sync on`. CLI-native,
 * deterministic, keeps the app running so edits still work, and is literally the
 * "pause sync" feature a user would use. No network/podman manipulation.
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

// Pinned per-node network identity, so a reconnect restores the EXACT same IP/MAC the
// container had before (and from its very first `containers-up` — see the Makefile) rather
// than a fresh dynamically-assigned one — see docs/DESIGN.md for why, and for the story behind
// the MAC address's first byte specifically.
// Node number comes from the trailing digits of its name (n1 -> 1, n2 -> 2); X = 100 + number.
// IP = 10.89.0.<X> (matches obsidian-net's actual 10.89.0.0/24 subnet).
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
 * Detach/attach a container from a Podman network — the real "device goes
 * offline" fault. We don't trust the command to take effect instantly (an
 * in-flight sync can keep draining); instead we BLOCK until the container's own
 * connectivity confirms it, with a TCP reachability probe to a well-known numeric
 * endpoint (8.8.8.8:53 — no DNS): disconnect waits until it's unreachable, connect
 * until reachable. (TCP, not ping: rootless podman blocks ICMP — no raw socket.)
 * This is a pure network-state check, independent of what Obsidian does about it.
 */
export class PodmanIsolator implements Isolator {
  onEvent?: (event: Record<string, unknown>) => void;
  /** Delay between reachability polls; overridable so tests don't wait real time. */
  pollDelayMs = 500;

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
    const r = await runProcess("podman", [
      "exec", node, "timeout", "2", "bash", "-c", `echo > /dev/tcp/${this.host}/${this.port}`,
    ]);
    return r.code === 0;
  }

  /** Poll `reachable()` (probe first, sleep last — never the other way round) until it matches
   *  `want`. EVERY attempt is logged, including the one that finally confirms — the internal step
   *  needs to be visible even when it succeeds on the very first try (the common case in practice:
   *  the podman network toggle takes effect near-instantly, so without this, "log internal steps"
   *  produced zero events in every real run). */
  private async waitReach(node: NodeId, want: boolean, label: string): Promise<void> {
    const start = Date.now();
    const deadline = start + this.capMs;
    for (let attempt = 1; ; attempt++) {
      const got = await this.reachable(node);
      this.emit({ kind: "network-probe", node, label, want, reachable: got, attempt, elapsedMs: Date.now() - start });
      if (got === want) return;
      if (Date.now() > deadline) {
        throw new Error(`${label} ${node}: ${this.host}:${this.port} ${want ? "still unreachable" : "still reachable"} after ${this.capMs / 1000}s`);
      }
      await sleep(this.pollDelayMs);
    }
  }

  async disconnect(node: NodeId): Promise<void> {
    // Ignore command errors (e.g. already disconnected) — reachability is the truth.
    await runProcess("podman", ["network", "disconnect", this.network, node]);
    await this.waitReach(node, false, "disconnect");
  }

  async connect(node: NodeId): Promise<void> {
    const { ip, mac } = nodeAddress(node);
    await runProcess("podman", ["network", "connect", "--ip", ip, "--mac-address", mac, this.network, node]);
    await this.waitReach(node, true, "connect");
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
