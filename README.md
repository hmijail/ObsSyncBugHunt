# Obsidian Sync Tester

A small TypeScript harness that hunts for **data loss in Obsidian Sync** when the
same note is edited on two devices. Everything is driven through the **Obsidian
CLI** (no direct file writes), so Sync engages exactly as it would for a human.

## What it tests

Two nodes edit the same note from a common base while one is offline, then
reconcile. Each edit appends a **uniquely-tagged line** (`op-<node>-<seq>-<uuid>`),
so once sync settles the oracle can verify by exact match that **every
acknowledged edit survived** somewhere in `canonical ∪ (Conflicted copy …)` files.

The oracle (`src/oracle.ts`, unit-tested) flags:

- **loss** — an acknowledged token present nowhere (e.g. a conflict file that
  should have been created wasn't),
- **duplication** — a token repeated within a file,
- **divergence** — nodes disagree on final content or conflict-file set.

Nodes are configured identically to **"create conflict file"** mode.

## Faults

A node must be **running but unable to sync** to diverge (the CLI needs the app
running). Two primitives, selected per run via `ISOLATOR`:

- `sync` — Obsidian's own `sync off` / `sync on`; cooperative, the **control baseline**.
- `network` — detach the container from its Podman network; rude, the bug hunt.

Quiescence is read from Obsidian's own `sync:status` (`synced`), not fixed timeouts.

## Sync behavior it relies on

Markdown conflicts resolve either by **auto-merge** (Google diff-match-patch) or by
writing a **`(Conflicted copy <device> <ts>).md`** file (per-device setting, since
v1.9.7). Server-side version history is reachable via `sync:history` / `sync:read`.
Source: [Obsidian Help — Sync troubleshooting](https://obsidian.md/help/sync/troubleshoot).

## Layout

```
src/
  driver.ts     Obsidian CLI wrapper
  exec.ts       Local / Podman executors
  oracle.ts     convergence/loss verdict (oracle.test.ts)
  runner.ts     divergence-round orchestrator
  isolate.ts    fault primitives
  history.ts    per-run JSONL + results.json
  run.ts        containerized entrypoint   (npm run start)
  run-local.ts  single-node pipeline check (npm run local)
  smoke.ts      driver probe              (npm run smoke)
containers/     Dockerfile + entrypoint (Obsidian under Xvfb)
Makefile        podman lifecycle: build -> login -> capture -> up -> run
```

## Running

`make help` lists every command. Common flows:

```sh
make install && make check   # install + typecheck + unit tests

# single-node pipeline check (open the throwaway vault in Obsidian first):
make local                   # TEST_VAULT=Throwaway by default (override: make local TEST_VAULT=Foo)

# two-node containers:
make build && make login     # VNC in, link a TEST remote vault, "create conflict file"
make capture                 # copies the login into ./secrets (git-ignored), not an image
make up && make run          # or: ISOLATOR=network make run
```

## Tooling

Node is pinned in `.nvmrc` (23.6.0), enforced by `engines` + `engine-strict`; use
`npm ci` for lockfile-exact installs.
