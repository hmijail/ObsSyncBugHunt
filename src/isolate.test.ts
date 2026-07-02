import test from "node:test";
import assert from "node:assert/strict";
import { nodeAddress, PodmanIsolator } from "./isolate.js";

test("nodeAddress: n1 -> 10.89.0.101 / 6e:62:6e:65:74:65", () => {
  assert.deepEqual(nodeAddress("n1"), { ip: "10.89.0.101", mac: "6e:62:6e:65:74:65" });
});

test("nodeAddress: n2 -> 10.89.0.102 / 6e:62:6e:65:74:66", () => {
  assert.deepEqual(nodeAddress("n2"), { ip: "10.89.0.102", mac: "6e:62:6e:65:74:66" });
});

test("nodeAddress: a node name with no trailing digits throws", () => {
  assert.throws(() => nodeAddress("login"), /can't derive a node number/);
});

test("nodeAddress: a node number that would overflow a single address byte throws", () => {
  assert.throws(() => nodeAddress("n999"), /too large/);
});

// Drive the private waitReach() directly (via the probeFn test seam), bypassing the public
// connect()/disconnect() so no real `podman network ...` call is needed either.
function isolatorWithProbes(results: boolean[]): { isolator: PodmanIsolator; calls: number } {
  let calls = 0;
  const probeFn = async () => results[Math.min(calls++, results.length - 1)];
  const isolator = new PodmanIsolator("net", "8.8.8.8", 53, 30_000, probeFn);
  isolator.pollDelayMs = 0; // no real waiting in the test
  return { isolator, get calls() { return calls; } };
}

test("waitReach: one network-probe event per attempt, including the final confirming one", async () => {
  const { isolator } = isolatorWithProbes([false, false, true]); // unreachable, unreachable, reachable
  const events: Record<string, unknown>[] = [];
  isolator.onEvent = (e) => events.push(e);
  await (isolator as unknown as { waitReach: (n: string, w: boolean, l: string) => Promise<void> })
    .waitReach("n1", true, "connect");
  assert.equal(events.length, 3); // all three attempts, including the successful third
  assert.deepEqual(events.map((e) => e.attempt), [1, 2, 3]);
  assert.deepEqual(events.map((e) => e.reachable), [false, false, true]);
  assert.ok(events.every((e) => e.kind === "network-probe" && e.want === true));
});

test("waitReach: probes first, sleeps last (returns on attempt 1 without ever sleeping)", async () => {
  const seam = isolatorWithProbes([true]); // reachable immediately
  const events: Record<string, unknown>[] = [];
  seam.isolator.onEvent = (e) => events.push(e);
  await (seam.isolator as unknown as { waitReach: (n: string, w: boolean, l: string) => Promise<void> })
    .waitReach("n1", true, "connect");
  assert.equal(seam.calls, 1); // returned right after the single probe, never looped into a sleep
  assert.equal(events.length, 1);
  assert.equal(events[0].reachable, true);
});

test("waitReach: gives up past the cap with a descriptive error, no onEvent set falls back to console", async () => {
  const isolator = new PodmanIsolator("net", "8.8.8.8", 53, 0, async () => false); // capMs=0 -> first check already past deadline
  isolator.pollDelayMs = 0;
  await assert.rejects(
    (isolator as unknown as { waitReach: (n: string, w: boolean, l: string) => Promise<void> })
      .waitReach("n1", true, "connect"),
    /connect n1: 8\.8\.8\.8:53 still unreachable after 0s/,
  );
});
