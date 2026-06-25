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
# Number of histories for `make campaign` (override: make campaign HISTORIES=50)
HISTORIES  ?= 20

.DEFAULT_GOAL := help
.PHONY: help install typecheck test check smoke local \
        build net secrets-dir clean-secrets login capture node1 containers-up solo-check run campaign soak analyze generate \
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
	TEST_VAULT="$(TEST_VAULT)" npm run smoke

local: ## Single-node pipeline check against a local throwaway vault
	TEST_VAULT="$(TEST_VAULT)" npm run local

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

node1: build net ## Run a single node (n1) with VNC published, for inspection/debugging
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture"; exit 1; }
	-podman rm -f n1 2>/dev/null || true
	podman run -d --name n1 --hostname n1 --network $(NET) \
	  -p $(VNC_PORT):5900 -v $(SECRETS):/secrets:ro $(IMAGE)
	@scripts/wait-node.sh n1
	@echo "n1 ready. Inspect via VNC: vnc://localhost:$(VNC_PORT) (password: obsidian)."

containers-up: build net ## Launch n1 + n2 (each seeds from ./secrets; VNC published per node)
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture"; exit 1; }
	@port=$(VNC_PORT); for n in $(NODES); do \
	  podman rm -f $$n 2>/dev/null || true; \
	  echo "starting $$n (VNC localhost:$$port)"; \
	  podman run -d --name $$n --hostname $$n --network $(NET) \
	    -p $$port:5900 -v $(SECRETS):/secrets:ro $(IMAGE); \
	  port=$$((port+1)); \
	done
	@for n in $(NODES); do scripts/wait-node.sh $$n; done
	@echo "nodes ready: $(NODES). VNC from localhost:$(VNC_PORT) (password: obsidian). Then: make run"

solo-check:
	@# Isolation guard: every node shares the same cloned Sync login, so a stray
	@# container on the test network would confound the run. Abort if anything
	@# running isn't one of the intended NODES.
	@for c in $$(podman ps --filter network=$(NET) --format '{{.Names}}'); do \
	  echo " $(NODES) " | grep -q " $$c " || { \
	    echo "stray container '$$c' running on $(NET) — stop it first (e.g. 'make containers-down')"; exit 1; }; \
	done
	@# Warn when reusing long-lived nodes (accumulated vault/conflict cruft can
	@# skew a run); 'make containers-up' recreates them fresh from the captured login.
	@for n in $(NODES); do \
	  up=$$(podman ps --filter "name=^$$n$$" --format '{{.RunningFor}}' 2>/dev/null); \
	  [ -n "$$up" ] && echo "[warn] reusing existing container $$n (up $$up) — run 'make containers-up' for a fresh start" || true; \
	done

run: solo-check ## Run ONE generated history (SCENARIO=random|stale OPS=min-max ISOLATOR=sync|network)
	NODES="$(shell echo $(NODES) | tr ' ' ',')" npm run start

campaign: solo-check ## Run HISTORIES histories and tally the error rate (HISTORIES=N SCENARIO=... OPS=...)
	NODES="$(shell echo $(NODES) | tr ' ' ',')" HISTORIES="$(HISTORIES)" npm run start

soak: solo-check ## Run histories until stopped (Ctrl-C) for an overnight run; DURATION_MIN=N for a fixed span
	NODES="$(shell echo $(NODES) | tr ' ' ',')" HISTORIES=0 npm run start

analyze: ## Aggregate runs/ into a report (CONFIRMED losses, conflicts, sync-time distribution)
	npm run analyze

generate: ## Print N generated histories without running them (N=20; honours TURNS/OPS/NOTES/PARTITION_PROB/SCENARIO)
	GENERATE="$(or $(N),20)" npm run start

clean-notes: solo-check ## Delete every note in the vault on all nodes for a clean baseline (nodes must be up)
	NODES="$(shell echo $(NODES) | tr ' ' ',')" npm run clean-notes

clean-runs: ## Wipe local run results/logs (rm -rf runs/)
	rm -rf runs

clean-data: clean-notes ## Fresh slate for a soak: empty the vault (clean-notes) + wipe runs/ (nodes must be up)
	rm -rf runs

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
