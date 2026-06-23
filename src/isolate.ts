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
  constructor(
    private readonly network: string,
    private readonly host = "8.8.8.8",
    private readonly port = 53,
    private readonly capMs = 30_000,
  ) {}

  private async reachable(node: NodeId): Promise<boolean> {
    const r = await runProcess("podman", [
      "exec", node, "timeout", "2", "bash", "-c", `echo > /dev/tcp/${this.host}/${this.port}`,
    ]);
    return r.code === 0;
  }

  private async waitReach(node: NodeId, want: boolean, label: string): Promise<void> {
    const deadline = Date.now() + this.capMs;
    for (;;) {
      if ((await this.reachable(node)) === want) return;
      if (Date.now() > deadline) {
        throw new Error(`${label} ${node}: ${this.host}:${this.port} ${want ? "still unreachable" : "still reachable"} after ${this.capMs / 1000}s`);
      }
      await sleep(500);
    }
  }

  async disconnect(node: NodeId): Promise<void> {
    // Ignore command errors (e.g. already disconnected) — reachability is the truth.
    await runProcess("podman", ["network", "disconnect", this.network, node]);
    await this.waitReach(node, false, "disconnect");
  }

  async connect(node: NodeId): Promise<void> {
    await runProcess("podman", ["network", "connect", this.network, node]);
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
