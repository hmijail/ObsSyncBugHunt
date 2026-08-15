import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { engineBin, engineVersion, connectPinsMac, resetEngineCache } from "./engine.js";

// Both `engineBin` and the capability probes are memoized per process, and every test here wants
// a different answer — so each one sets up its own environment and resets the cache first.
// (Node's test runner runs a file's tests serially, so this stays deterministic.)
const savedPath = process.env.PATH;
const savedEngine = process.env.CONTAINER_ENGINE;

function withEnv(env: { PATH?: string; CONTAINER_ENGINE?: string }): void {
  resetEngineCache();
  if (env.PATH === undefined) delete process.env.PATH; else process.env.PATH = env.PATH;
  if (env.CONTAINER_ENGINE === undefined) delete process.env.CONTAINER_ENGINE;
  else process.env.CONTAINER_ENGINE = env.CONTAINER_ENGINE;
}

test.after(() => {
  resetEngineCache();
  process.env.PATH = savedPath;
  if (savedEngine === undefined) delete process.env.CONTAINER_ENGINE;
  else process.env.CONTAINER_ENGINE = savedEngine;
});

/** A directory holding executable stubs, to stand in for a PATH entry with an engine installed. */
function stubDir(stubs: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "engine-test-"));
  for (const [name, body] of Object.entries(stubs)) {
    const p = path.join(dir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return dir;
}

test("engineBin: CONTAINER_ENGINE wins over anything on PATH", () => {
  withEnv({ PATH: stubDir({ podman: "#!/bin/sh\n" }), CONTAINER_ENGINE: "my-engine" });
  assert.equal(engineBin(), "my-engine");
});

test("engineBin: prefers podman when both are installed", () => {
  withEnv({ PATH: stubDir({ podman: "#!/bin/sh\n", docker: "#!/bin/sh\n" }) });
  assert.equal(engineBin(), "podman");
});

test("engineBin: picks docker when that's the only one installed", () => {
  withEnv({ PATH: stubDir({ docker: "#!/bin/sh\n" }) });
  assert.equal(engineBin(), "docker");
});

// Falling back rather than throwing is deliberate: the useful error is the one the real command
// produces, against a visible argv, not an import-time crash far from the call site.
test("engineBin: with neither installed, falls back to a name instead of throwing", () => {
  withEnv({ PATH: "" });
  assert.equal(engineBin(), "docker");
});

test("engineVersion: reports the engine's own self-report, not a guess", async () => {
  const dir = stubDir({ eng: "#!/bin/sh\necho 'podman version 5.4.0'\n" });
  withEnv({ PATH: "", CONTAINER_ENGINE: path.join(dir, "eng") });
  assert.equal(await engineVersion(), "podman version 5.4.0");
});

// The capability that actually differs between engines, probed from the binary rather than
// inferred from its name — the whole point being that a `docker`-NAMED podman shim must still
// report podman's capabilities (and vice versa).
test("connectPinsMac: true when `network connect --help` advertises --mac-address", async () => {
  const dir = stubDir({ docker: "#!/bin/sh\necho '      --mac-address string   Container MAC'\n" });
  withEnv({ PATH: "", CONTAINER_ENGINE: path.join(dir, "docker") });
  assert.equal(await connectPinsMac(), true);
});

test("connectPinsMac: false when the flag isn't offered", async () => {
  const dir = stubDir({ podman: "#!/bin/sh\necho '      --ip ip   IPv4 address'\n" });
  withEnv({ PATH: "", CONTAINER_ENGINE: path.join(dir, "podman") });
  assert.equal(await connectPinsMac(), false);
});

// A probe that can't run at all must read as "can't do it", never crash the harness.
test("connectPinsMac: a missing/failing engine binary reads as false, not a throw", async () => {
  withEnv({ PATH: "", CONTAINER_ENGINE: "/nonexistent/engine-binary" });
  assert.equal(await connectPinsMac(), false);
});
