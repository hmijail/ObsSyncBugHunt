import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodeIp, NetworkIsolator, EnvironmentAssumptionError } from "./isolate.js";

test("nodeIp: n1 -> 10.89.0.101", () => {
  assert.equal(nodeIp("n1"), "10.89.0.101");
});

test("nodeIp: n2 -> 10.89.0.102", () => {
  assert.equal(nodeIp("n2"), "10.89.0.102");
});

test("nodeIp: a node name with no trailing digits throws", () => {
  assert.throws(() => nodeIp("login"), /can't derive a node number/);
});

// `nodeIp` and the Makefile's SUBNET are two independently-written constants that MUST agree:
// nodes are started and reconnected with `--ip <nodeIp(n)>` into a network created with that
// subnet, so if they drift apart every `containers-up` and every `C` fails with an engine-level
// error. `make check-assumptions` checks the live network against the addresses make computes;
// this checks the addresses the HARNESS computes against the declared subnet — the half no
// environment check can see, since editing this file leaves a correct network still correct.
// Same "read the sibling file so the pair stays in step" idiom as repro.test.ts.
test("nodeIp: every node address falls inside the Makefile's declared SUBNET", () => {
  const makefile = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "Makefile"), "utf8");
  const declared = /^SUBNET\s*:?=\s*(\d+\.\d+\.\d+\.\d+)\/(\d+)\s*$/m.exec(makefile);
  assert.ok(declared, "Makefile must declare SUBNET as a CIDR");
  const [, base, prefixStr] = declared;
  const toInt = (ip: string) => ip.split(".").reduce((acc, o) => acc * 256 + Number(o), 0);
  const size = 2 ** (32 - Number(prefixStr));
  const netBase = Math.floor(toInt(base) / size) * size;
  const inside = (ip: string) => toInt(ip) >= netBase && toInt(ip) < netBase + size;

  for (const node of ["n1", "n2"]) {
    assert.ok(inside(nodeIp(node)), `${node} -> ${nodeIp(node)} is outside ${base}/${prefixStr}`);
  }
  // The highest node number nodeIp will produce at all must fit too — otherwise the subnet is
  // narrower than the addressing scheme and the failure only shows up at some larger NODES=.
  assert.ok(inside(nodeIp("n155")), `n155 -> ${nodeIp("n155")} is outside ${base}/${prefixStr}`);
});

test("nodeIp: a node number that would overflow a single address byte throws", () => {
  assert.throws(() => nodeIp("n999"), /too large/);
});

// Drive the private waitReach() directly (via the probeFn test seam), bypassing the public
// connect()/disconnect() so no real `podman network ...` call is needed either.
function isolatorWithProbes(results: boolean[]): { isolator: NetworkIsolator; calls: number } {
  let calls = 0;
  const probeFn = async () => results[Math.min(calls++, results.length - 1)];
  const isolator = new NetworkIsolator("net", "8.8.8.8", 53, 30_000, probeFn);
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
  const isolator = new NetworkIsolator("net", "8.8.8.8", 53, 0, async () => false); // capMs=0 -> first check already past deadline
  isolator.pollDelayMs = 0;
  await assert.rejects(
    (isolator as unknown as { waitReach: (n: string, w: boolean, l: string) => Promise<void> })
      .waitReach("n1", true, "connect"),
    /connect n1: 8\.8\.8\.8:53 still unreachable after 0s/,
  );
});

// A D/C is only the experiment it claims to be if the reconnect is a brief blip. A slow one means
// the fault primitive is broken, which invalidates every following rep too — so it ABORTS the run
// rather than being recorded and passed over. `enforceBlipBudget` is the decision, split out of
// connect() precisely so it can be driven here without a real engine call.
type BudgetSeam = { enforceBlipBudget: (n: string, ms: number, d: Record<string, unknown>) => void };
function budgetSeam(budgetMs?: number): { isolator: NetworkIsolator; events: Record<string, unknown>[] } {
  const isolator = new NetworkIsolator("net", "8.8.8.8", 53, 30_000, async () => true);
  isolator.pollDelayMs = 0;
  if (budgetMs !== undefined) isolator.reconnectBudgetMs = budgetMs;
  const events: Record<string, unknown>[] = [];
  isolator.onEvent = (e) => events.push(e);
  return { isolator, events };
}

test("connect: a reconnect within budget is silent — no event, no throw", () => {
  const { isolator, events } = budgetSeam(1_000);
  (isolator as unknown as BudgetSeam).enforceBlipBudget("n1", 60, {});
  assert.deepEqual(events, []);
});

test("connect: exactly at the budget is still within it (boundary is inclusive)", () => {
  const { isolator, events } = budgetSeam(1_000);
  (isolator as unknown as BudgetSeam).enforceBlipBudget("n1", 1_000, {});
  assert.deepEqual(events, []);
});

test("connect: over budget throws EnvironmentAssumptionError, aborting the run", () => {
  const { isolator } = budgetSeam(1_000);
  assert.throws(
    () => (isolator as unknown as BudgetSeam).enforceBlipBudget("n2", 4_200, { ip: "10.89.0.102" }),
    (err: unknown) => {
      assert.ok(err instanceof EnvironmentAssumptionError);
      assert.match(err.assumption, /reconnecting n2 took 4200ms, over the 1000ms blip budget/);
      assert.match(err.remedy, /make check-assumptions/); // must tell the operator what to do
      assert.equal(err.detail.node, "n2");
      assert.equal(err.detail.reconnectMs, 4_200);
      assert.equal(err.detail.ip, "10.89.0.102"); // caller-supplied detail is carried through
      return true;
    },
  );
});

// The throw aborts the run, so the measurement has to already be on disk when it does.
test("connect: the slow-reconnect event is emitted BEFORE the throw, so forensics survive", () => {
  const { isolator, events } = budgetSeam(1_000);
  assert.throws(() => (isolator as unknown as BudgetSeam).enforceBlipBudget("n1", 3_000, {}));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "slow-reconnect");
  assert.equal(events[0].reconnectMs, 3_000);
  assert.equal(events[0].budgetMs, 1_000);
});

test("waitReach returns the elapsed time, which is what the reconnect budget is judged on", async () => {
  const { isolator } = budgetSeam();
  const elapsed = await (isolator as unknown as { waitReach: (n: string, w: boolean, l: string) => Promise<number> })
    .waitReach("n1", true, "connect");
  assert.equal(typeof elapsed, "number");
  assert.ok(elapsed >= 0);
});

test("reconnectBudgetMs defaults to 1s — the 'brief blip' threshold (--reconnect-budget-ms overrides)", () => {
  assert.equal(new NetworkIsolator("net").reconnectBudgetMs, 1_000);
});
