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

/** Detach/attach a container from a Podman network. */
export class PodmanIsolator implements Isolator {
  constructor(private readonly network: string) {}

  async disconnect(node: NodeId): Promise<void> {
    const r = await runProcess("podman", ["network", "disconnect", this.network, node]);
    if (r.code !== 0) throw new Error(`disconnect ${node}: ${r.stderr.trim()}`);
  }

  async connect(node: NodeId): Promise<void> {
    const r = await runProcess("podman", ["network", "connect", this.network, node]);
    if (r.code !== 0) throw new Error(`connect ${node}: ${r.stderr.trim()}`);
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
