# Single entry point for the Obsidian Sync tester.
#
#   Dev:        make install | typecheck | test | check | smoke | local
#   Containers: make login -> (VNC login) -> capture -> containers-up -> run  (then: containers-down)
#               (clean-secrets wipes a prior login first; or use build -> login directly)
#
# Credentials are captured into ./secrets (git-ignored) and mounted into nodes
# read-only — never baked into an image. Both nodes seed from the same login
# (same device identity = the deliberate clone/collision test).

IMAGE      := obsidian-node
LOGIN      := obsidian-login
NET        := obsidian-net
NODES      := n1 n2
# Host port for the login VNC (container side is 5900). 5900 clashes with macOS
# Screen Sharing, so default to 5901; override: make login VNC_PORT=5910
VNC_PORT   ?= 5901
SECRETS    := $(CURDIR)/secrets/obsidian
# Local throwaway vault for `make smoke` / `make local` (override: make local TEST_VAULT=Foo)
TEST_VAULT ?= Throwaway
# Node targeted by `make health` (override: make health NODE=n2)
NODE       ?= n1
# Local Mac's obsidian-cli (much faster than the GUI Obsidian binary) — enables the DSL's `M`
# node by default. Override/clear: make soak MAC_BIN= (or a different path)
MAC_BIN    ?= /Users/mija/Applications/Obsidian.app/Contents/MacOS/obsidian-cli

# Bound podman calls in solo-check so a wedged podman API fails fast with a hint
# instead of hanging silently. Uses `timeout` (or `gtimeout` from coreutils on macOS)
# when available; the guard is a no-op otherwise. Override the budget: PODMAN_TIMEOUT=20
PODMAN_TIMEOUT ?= 10
TIMEOUT_BIN := $(shell command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null)
PODMAN_GUARD := $(if $(TIMEOUT_BIN),$(TIMEOUT_BIN) $(PODMAN_TIMEOUT))

NODES_CSV := $(shell echo $(NODES) | tr ' ' ',')
# Knobs forwarded to the CLI. --nodes/--network always (structural); the rest only
# when you set them — so make's recipe echo is the exact, copy-pasteable command and
# shows precisely what you overrode (e.g. `make soak TURNS=paced` -> `… --turns paced`).
RUN_FLAGS = --nodes $(NODES_CSV) --network $(NET) \
  $(if $(OBSIDIAN_BIN),--bin $(OBSIDIAN_BIN)) \
  $(if $(ISOLATOR),--isolator $(ISOLATOR)) \
  $(if $(MAC_BIN),--mac-bin $(MAC_BIN)) \
  $(if $(MAC_NODE_ID),--mac-node-id $(MAC_NODE_ID)) \
  $(if $(SCENARIO),--scenario $(SCENARIO)) \
  $(if $(HISTORY),--history $(HISTORY)) \
  $(if $(STEPS),--steps $(STEPS)) \
  $(if $(OPS),--ops $(OPS)) \
  $(if $(NOTES),--notes $(NOTES)) \
  $(if $(TURNS),--turns $(TURNS)) \
  $(if $(PAUSE_PROB),--pause-prob $(PAUSE_PROB)) \
  $(if $(PARTITION_PROB),--partition-prob $(PARTITION_PROB)) \
  $(if $(REPEAT),--repeat $(REPEAT)) \
  $(if $(DURATION_MIN),--duration-min $(DURATION_MIN)) \
  $(if $(SKIP_HOST_CHECK),--skip-host-check) \
  $(if $(POLL_SEC),--poll-sec $(POLL_SEC)) \
  $(if $(MIN_FLOOR_SEC),--min-floor-sec $(MIN_FLOOR_SEC)) \
  $(if $(CAP_SEC),--cap-sec $(CAP_SEC)) \
  $(if $(W_SETTLE_SEC),--w-settle-sec $(W_SETTLE_SEC)) \
  $(if $(FINAL_SETTLE_SEC),--final-settle-sec $(FINAL_SETTLE_SEC)) \
  $(if $(PROBE_SEC),--probe-sec $(PROBE_SEC)) \
  $(if $(RUNS_PREFIX),--runs-prefix $(RUNS_PREFIX)) \
  $(if $(SKIP_SNAPSHOT_TIMING),--skip-snapshot-timing)

.DEFAULT_GOAL := help
.PHONY: help install typecheck test check smoke local \
        build net secrets-dir clean-secrets login capture node1 containers-up solo-check reconnect run campaign soak analyze generate \
        clean-runs clean-notes clean-data clean-images trial containers-down ps logs health

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

# ---- dev -------------------------------------------------------------------

install: ## Reproducible install from the lockfile (npm ci)
	npm ci

typecheck: ## Type-check the project
	npm run typecheck

test: ## Run unit tests (the oracle)
	npm test

check: typecheck test ## Type-check + unit tests

smoke: ## Probe the driver against a local throwaway vault (TEST_VAULT=...)
	npm run smoke -- --vault $(TEST_VAULT)

local: ## Single-node pipeline check against a local throwaway vault
	npm run local -- --vault $(TEST_VAULT)

# ---- containers ------------------------------------------------------------

build: ## Build the node image
	podman build -t $(IMAGE) containers

net:
	podman network exists $(NET) || podman network create $(NET)

secrets-dir:
	mkdir -p $(SECRETS)

clean-secrets: containers-down ## Wipe the captured login (./secrets) + login container (then: make login -> capture)
	-podman rm -f $(LOGIN) 2>/dev/null || true
	rm -rf $(SECRETS)
	@echo "Wiped $(SECRETS) and the login container. Next: make login && make capture"

login: build net secrets-dir ## Start a VNC container for the one-time Sync login
	-podman rm -f $(LOGIN) 2>/dev/null || true
	podman run -d --name $(LOGIN) --network $(NET) \
	  -p $(VNC_PORT):5900 \
	  -v $(SECRETS):/secrets:rw $(IMAGE)
	@echo
	@echo "VNC ready at localhost:$(VNC_PORT) (password: obsidian); TestVault opens automatically."
	@echo "  1. enable CLI: Settings > General > Advanced > Command line interface"
	@echo "  2. Account: sign in to your Obsidian account"
	@echo "  3. Sync: connect/create the TEST remote vault, set 'Create conflict file'"
	@echo "  4. wait for full sync, then: make capture"

capture: ## Copy the login out of the container into ./secrets, then stop it
	podman exec $(LOGIN) sh -c '\
	  mkdir -p /secrets/config /secrets/vault && \
	  cp -a /root/.config/obsidian/. /secrets/config/ && \
	  cp -a /root/vaults/TestVault/.obsidian/. /secrets/vault/'
	podman rm -f $(LOGIN)
	@echo "Captured login into $(SECRETS) (git-ignored). Next: make containers-up"

# Pinned per-node network identity (see src/isolate.ts's nodeAddress — same scheme, kept in
# sync): node number from the trailing digits of its name; X = 100+number; IP 10.89.0.<X>
# (matches obsidian-net's actual 10.89.0.0/24 subnet); MAC 6e:62:6e:65:74:<X in hex> ("nbnet",
# not the cleaner "obnet" — the first byte's I/G bit marks individual/group addressing, and
# 0x6f ('o') has it SET, i.e. multicast, which the kernel refuses to assign to a real interface;
# 0x6e ('n') is a valid unicast, locally-administered first byte). The last byte must still be
# hex, not decimal digits. Applied at every `podman run`/`network connect` for a node so a
# reconnect restores the SAME identity the container has had since its very first start — the
# identity never changes at all, on the theory that Sync recognizing "the same device,
# unchanged" reconnects faster than a fresh join.
NODE_ADDR = num=$${n\#n}; addr=$$((100+num)); ip=10.89.0.$$addr; mac=6e:62:6e:65:74:$$(printf '%02x' $$addr)

node1: build net ## Run a single node (n1) with VNC published, for inspection/debugging
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture"; exit 1; }
	-podman rm -f n1 2>/dev/null || true
	@n=n1; $(NODE_ADDR); \
	  podman run -d --name n1 --hostname n1 --network $(NET) --ip $$ip --mac-address $$mac \
	    -p $(VNC_PORT):5900 -v $(SECRETS):/secrets:ro $(IMAGE)
	@scripts/wait-node.sh n1
	@echo "n1 ready. Inspect via VNC: vnc://localhost:$(VNC_PORT) (password: obsidian)."

containers-up: build net ## Launch n1 + n2 (each seeds from ./secrets; VNC published per node)
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture"; exit 1; }
	@port=$(VNC_PORT); for n in $(NODES); do \
	  podman rm -f $$n 2>/dev/null || true; \
	  $(NODE_ADDR); \
	  echo "starting $$n (VNC localhost:$$port, $$ip)"; \
	  podman run -d --name $$n --hostname $$n --network $(NET) --ip $$ip --mac-address $$mac \
	    -p $$port:5900 -v $(SECRETS):/secrets:ro $(IMAGE); \
	  port=$$((port+1)); \
	done
	@for n in $(NODES); do scripts/wait-node.sh $$n; done
	@echo "nodes ready: $(NODES). VNC from localhost:$(VNC_PORT) (password: obsidian). Then: make run"

solo-check:
	@echo "solo-check: inspecting containers on $(NET)…$(if $(PODMAN_GUARD),, (no 'timeout' found — install coreutils for a hang guard))"
	@# Isolation guard: every node shares the same cloned Sync login, so a stray
	@# container on the test network would confound the run. Abort if anything running
	@# isn't one of the intended NODES. The podman call is time-bounded ($(PODMAN_GUARD))
	@# so a wedged podman API fails fast with a hint instead of hanging silently.
	@names=$$($(PODMAN_GUARD) podman ps --filter network=$(NET) --format '{{.Names}}'); rc=$$?; \
	  if [ $$rc -eq 124 ]; then \
	    echo "podman unresponsive (timed out after $(PODMAN_TIMEOUT)s) — the machine may be wedged; try: podman machine stop && podman machine start"; exit 1; fi; \
	  if [ $$rc -ne 0 ]; then \
	    echo "podman ps failed (rc=$$rc) — is the podman machine running? ('podman machine start')"; exit 1; fi; \
	  for c in $$names; do \
	    echo " $(NODES) " | grep -q " $$c " || { \
	      echo "stray container '$$c' running on $(NET) — stop it first (e.g. 'make containers-down')"; exit 1; }; \
	  done
	@# Warn when reusing long-lived nodes (accumulated vault/conflict cruft can
	@# skew a run); 'make containers-up' recreates them fresh from the captured login.
	@for n in $(NODES); do \
	  up=$$($(PODMAN_GUARD) podman ps --filter "name=^$$n$$" --format '{{.RunningFor}}' 2>/dev/null); \
	  [ -n "$$up" ] && echo "[warn] reusing existing container $$n (up $$up) — run 'make containers-up' for a fresh start" || true; \
	done

reconnect: ## Reconnect all NODES to the network (fixes a node left detached by an interrupted soak)
	@for n in $(NODES); do \
	  $(NODE_ADDR); \
	  $(PODMAN_GUARD) podman network connect --ip $$ip --mac-address $$mac $(NET) $$n 2>/dev/null && echo "reconnected $$n ($$ip)" || echo "$$n already connected (or absent)"; \
	done

# run/campaign/soak depend on `reconnect`: a Ctrl-C'd soak can leave a node detached (a `D`
# with no matching `C`), and partitions are always per-rep, so every node should be attached
# at the start of a run. (Not folded into `net`: that runs before containers exist.)
run: solo-check reconnect ## Run ONE history: generated, or HISTORY=<dsl> (REPEAT=N; STEPS=K runs only its first K ops)
	npm run start -- $(RUN_FLAGS)

campaign: solo-check reconnect ## Run HISTORIES histories and tally the error rate (HISTORIES=N TURNS=... OPS=...)
	npm run start -- --histories $(or $(HISTORIES),20) $(RUN_FLAGS)

soak: solo-check reconnect ## Run until stopped (Ctrl-C); DURATION_MIN=N for a fixed span. HISTORY=<dsl> soaks that one history
	npm run start -- --histories 0 $(RUN_FLAGS)

# RUNS_PREFIX-aware path to the runs/ tree, so analyze/clean-runs/clean-data stay consistent
# with wherever `make run`/`soak` (via --runs-prefix) put it.
RUNS_DIR := $(if $(RUNS_PREFIX),$(RUNS_PREFIX)/runs,runs)

analyze: ## Aggregate runs/ into runs/analysis.md (state tables by outcome, sync-time distribution)
	npm run analyze -- $(RUNS_DIR)

generate: ## Print N generated histories without running them (N=20; honours TURNS/OPS/NOTES/PARTITION_PROB/SCENARIO)
	npm run start -- --generate $(or $(N),20) $(RUN_FLAGS)

clean-notes: solo-check ## Delete the harness's notes (the bughunt/ folder only) on all nodes (nodes must be up)
	npm run clean-notes -- --nodes $(NODES_CSV)

clean-runs: ## Wipe local run results/logs (rm -rf runs/)
	rm -rf $(RUNS_DIR)

clean-data: clean-notes ## Fresh slate for a soak: clear the harness's notes (bughunt/) + wipe runs/ (nodes must be up)
	rm -rf $(RUNS_DIR)

trial: containers-up run ## Clean-slate run: recreate + gate the nodes, then run one history from cold

containers-down: ## Stop + remove n1/n2
	-@for n in $(NODES); do podman rm -f $$n 2>/dev/null || true; done

ps: ## List containers on the test network
	podman ps --filter network=$(NET)

logs: ## Tail Obsidian's log on the first node
	podman exec $(firstword $(NODES)) tail -n 80 /var/log/obsidian.log

health: ## Print a node's liveness report + save its screenshot to ./_shot.png (NODE=n1)
	@podman exec $(NODE) /usr/local/bin/obsidian-healthcheck
	@podman cp $(NODE):/var/log/obsidian-shot.png ./_shot.png && echo "screenshot -> ./_shot.png"

clean-images: containers-down ## Remove the node image + podman network (keeps ./secrets; use clean-secrets for that)
	-podman rm -f $(LOGIN) 2>/dev/null || true
	-podman rmi $(IMAGE) 2>/dev/null || true
	-podman network rm $(NET) 2>/dev/null || true
	@echo "Note: ./secrets kept. Run clean-secrets to discard the captured login."
