# Single entry point for the Obsidian Sync tester.
#
#   Dev:        make install | typecheck | test | check | smoke | local
#   Containers: make login -> (VNC login) -> capture-login -> containers-up -> run  (then: containers-down)
#               (clean-secrets wipes a prior login first; or use build -> login directly)
#
# Credentials are captured into ./secrets (git-ignored) and mounted into nodes
# read-only — never baked into an image. Both nodes seed from the same login
# (same device identity = the deliberate clone/collision test).

# ---- what we're testing ----------------------------------------------------
#
# The Obsidian build under test. It lives in the ./obsidian-version FILE, not in this Makefile:
#   make obsidian-latest            # what's the newest release upstream?
#   make obsidian-upgrade           # rewrite ./obsidian-version to it, then: make containers-up
#
# A file rather than a variable here because it is written by a program, not only read by one.
# `obsidian-upgrade` takes a version off the network and persists it; rewriting a whole-file value
# is `echo > file`, whereas rewriting an assignment inside a Makefile means anchoring a regex to a
# line of live build syntax and hoping nobody reformats it. It also makes the version readable by
# anything that isn't make (scripts/, CI, a `cat`) without parsing this file.
#
# Still overridable per-invocation, which is the point — bisecting a finding across releases is
# `make containers-up OBSIDIAN_VERSION=1.12.7` and back, touching nothing. `ifndef` (not `?=`)
# so the file is read exactly once, and only when nothing already supplied a value.
# Images are tagged by version (IMAGE_TAG below), so builds of different versions coexist and
# switching between them costs nothing. The version the CLI actually self-reports is recorded in
# every rep's `history` event (see run.ts) — that, not this file, is the authoritative record of
# what a given run tested.
VERSION_FILE := obsidian-version
ifndef OBSIDIAN_VERSION
OBSIDIAN_VERSION := $(shell tr -d '[:space:]' < $(VERSION_FILE) 2>/dev/null)
endif
ifeq ($(strip $(OBSIDIAN_VERSION)),)
$(error $(VERSION_FILE) is missing or empty — it holds the Obsidian release under test, e.g. "1.13.7". \
Restore it (git checkout $(VERSION_FILE)), or pass OBSIDIAN_VERSION=<x.y.z> for this invocation)
endif

# Container engine: podman or docker, whichever is installed (docker preferred — see below).
#
# ONE name, CONTAINER_ENGINE, used as both the make variable and the exported environment variable,
# so `make run CONTAINER_ENGINE=podman` and a bare `CONTAINER_ENGINE=podman npm run start -- ...`
# are the same setting. It is exported because the scripts/ helpers and the TypeScript harness
# (src/engine.ts) must drive the SAME engine as these targets — make creating containers under one
# engine while the harness exec'd into another fails in a thoroughly confusing way.
#
# DETECTION PREFERS DOCKER, then falls back to podman. `docker` is the name likelier to be right on
# an unknown machine: Podman ships a real `docker` executable via the podman-docker package, so
# there it reaches podman anyway — and engine.ts probes CAPABILITIES from the binary rather than
# trusting its name, so a docker-named podman is still driven correctly. The podman fallback is not
# decoration: a shell `alias docker=podman` does NOT survive into a make recipe or Node's execFile,
# and macOS/brew has no podman-docker package, so on those hosts only the real `podman` exists.
CONTAINER_ENGINE ?= $(shell command -v docker >/dev/null 2>&1 && echo docker || echo podman)
export CONTAINER_ENGINE

IMAGE      := obsidian-node
IMAGE_TAG  := $(IMAGE):$(OBSIDIAN_VERSION)
LOGIN      := obsidian-login
NET        := obsidian-net
# Fixed subnet for the test network, created explicitly rather than left to the engine's default.
# The per-node pinned IPs are 10.89.0.<100+n> (see NODE_ADDR below and isolate.ts's nodeIp);
# 10.89.0.0/24 happens to be podman's own default, but Docker's is 172.x, so leaving it implicit
# made every `--ip 10.89.0.x` unassignable there.
SUBNET     := 10.89.0.0/24
# Only consulted for a HISTORY-less run (generate/campaign/soak without HISTORY) — with HISTORY
# set, run.ts derives participants (which containers, and whether the local instance) straight
# from the DSL string itself, so this default never matters there. The literal "l" is the on/off
# switch for the local instance (DSL's `L`) — LOCAL_BIN below only supplies its binary path; add it
# (NODES="n1 n2 l") to include it in historyless generation. container-lifecycle targets below use
# CONTAINER_NODES (NODES minus "l") so they never try to manage it as a container.
NODES      := n1 n2
# NODES is space-separated internally (NODES_CSV below comma-joins it for the CLI flag) — but
# `make soak NODES=n1,l` (comma-separated, matching how the CLI itself takes --nodes) is a
# completely natural thing to type, and silently produced a single mangled word ("n1,l") that
# made every container-lifecycle target misbehave (e.g. solo-check flagging 'n1' itself as a
# stray container, since " n1 " never appears inside " n1,l "). Accept either form by
# normalizing commas to spaces right after NODES is set, whether from the default above or a
# command-line override (needs `override` — a plain `:=` here would be shadowed by the override).
empty :=
space := $(empty) $(empty)
comma := ,
override NODES := $(subst $(comma),$(space),$(NODES))
# Host port for the login VNC (container side is 5900). 5900 clashes with macOS
# Screen Sharing, so default to 5901; override: make login VNC_PORT=5910
VNC_PORT   ?= 5901
SECRETS    := $(CURDIR)/secrets/obsidian
# Local throwaway vault for `make smoke` / `make check-local` (override: make check-local TEST_VAULT=Foo)
TEST_VAULT ?= Throwaway
# Node targeted by `make health` (override: make health NODE=n2)
NODE       ?= n1
# The host's own obsidian-cli, only used when "l" is in NODES (see above). Bare command name,
# relying on the normal install/activation flow putting it on PATH (confirmed on both macOS and
# Linux) — override to a full path if it isn't: make soak LOCAL_BIN=/other/path
LOCAL_BIN  ?= obsidian

# Bound engine calls in solo-check so a wedged engine API fails fast with a hint
# instead of hanging silently. Uses `timeout` (or `gtimeout` from coreutils on macOS)
# when available; the guard is a no-op otherwise. Override the budget: ENGINE_TIMEOUT=20
ENGINE_TIMEOUT ?= 10
TIMEOUT_BIN := $(shell command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null)
ENGINE_GUARD := $(if $(TIMEOUT_BIN),$(TIMEOUT_BIN) $(ENGINE_TIMEOUT))

NODES_CSV := $(shell echo $(NODES) | tr ' ' ',')
# Real containers only — every container-lifecycle target (containers-up/down, reconnect,
# clean-notes, solo-check) iterates this, never $(NODES) directly, so "l" is never mistaken for
# a container to create/rm/exec-into.
CONTAINER_NODES     := $(filter-out l,$(NODES))
CONTAINER_NODES_CSV := $(shell echo $(CONTAINER_NODES) | tr ' ' ',')
# Knobs forwarded to the CLI. --nodes/--network always (structural); the rest only
# when you set them — so make's recipe echo is the exact, copy-pasteable command and
# shows precisely what you overrode (e.g. `make soak OPS=4-4` -> `… --ops 4-4`).
# FORCED_TURNS holds a DSL substring spliced in at each cross-node hand-off (W, P, P60, WP30) and
# EMPTY is meaningful: no forced hand-off at all. `$(if ...)` treats empty as unset, which would
# silently fall back to the default W — the same silent-wrong-experiment failure that strict
# --forced-turns validation exists to prevent — so presence is tested with `$(origin)` instead.
ifdef TURNS
$(error TURNS= is now FORCED_TURNS=, holding a DSL substring rather than a mode name: \
barrier -> FORCED_TURNS=W, paced -> FORCED_TURNS=P (or P60 for a longer one), \
immediate -> FORCED_TURNS= (empty). See src/generator.ts's parseForcedTurns)
endif

ifeq ($(origin FORCED_TURNS),undefined)
FORCED_TURNS_FLAG :=
else
FORCED_TURNS_FLAG := --forced-turns '$(FORCED_TURNS)'
endif

RUN_FLAGS = --nodes $(NODES_CSV) --network $(NET) \
  $(if $(OBSIDIAN_BIN),--bin $(OBSIDIAN_BIN)) \
  $(if $(ISOLATOR),--isolator $(ISOLATOR)) \
  $(if $(LOCAL_BIN),--local-bin $(LOCAL_BIN)) \
  $(if $(LOCAL_NODE_ID),--local-node-id $(LOCAL_NODE_ID)) \
  $(if $(LOCAL_VAULT_PIN),--local-vault-pin) \
  $(if $(HISTORY),--history $(HISTORY)) \
  $(if $(STEPS),--steps $(STEPS)) \
  $(if $(OPS),--ops $(OPS)) \
  $(if $(NOTES),--notes $(NOTES)) \
  $(FORCED_TURNS_FLAG) \
  $(if $(PREFIX),--prefix '$(PREFIX)') \
  $(if $(WAIT_PROB),--wait-prob $(WAIT_PROB)) \
  $(if $(PAUSE_PROB),--pause-prob $(PAUSE_PROB)) \
  $(if $(PAUSE_SEC),--pause-sec $(PAUSE_SEC)) \
  $(if $(LONG_PAUSE_PROB),--long-pause-prob $(LONG_PAUSE_PROB)) \
  $(if $(LONG_PAUSE_SEC),--long-pause-sec $(LONG_PAUSE_SEC)) \
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
  $(if $(RECONNECT_BUDGET_MS),--reconnect-budget-ms $(RECONNECT_BUDGET_MS)) \
  $(if $(RUNS_PREFIX),--runs-prefix $(RUNS_PREFIX)) \
  $(if $(SKIP_SNAPSHOT),--skip-snapshot) \
  $(if $(WOULD_FAIL_CHECK),--would-fail-check)

.DEFAULT_GOAL := help
.PHONY: help install typecheck test check smoke check-local \
        build-image net secrets-dir clean-secrets login capture-login node1 containers-up solo-check reconnect-nodes run campaign soak analyze generate-histories repro \
        clean-runs clean-notes clean-data clean-images trial containers-down ps logs health \
        list-images obsidian-latest obsidian-upgrade check-net check-assumptions

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

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

check-local: ## Single-node pipeline check against a local throwaway vault
	npm run local -- --vault $(TEST_VAULT)

# ---- containers ------------------------------------------------------------

build-image: ## Build the node image for OBSIDIAN_VERSION (tagged obsidian-node:<version>)
	$(CONTAINER_ENGINE) build --build-arg OBSIDIAN_VERSION=$(OBSIDIAN_VERSION) -t $(IMAGE_TAG) containers

# Create the test network if absent, with an EXPLICIT subnet — the per-node pinned IPs live in it
# (10.89.0.<100+n>), and leaving the subnet to the engine's default silently breaks them on any
# engine whose default isn't 10.89.0.0/24 (Docker's is 172.x). `network inspect` is the portable
# existence test: podman's `network exists` has no Docker equivalent.
#
# A pre-existing network with the WRONG subnet is the nasty case — every `--ip 10.89.0.x` would
# fail with an obscure engine error — so it's detected here and reported for what it is. The
# subnet is matched against the raw inspect JSON rather than a --format expression because the two
# engines shape that JSON differently (Docker: .IPAM.Config[].Subnet; podman: .subnets[].subnet).
net:
	@if $(CONTAINER_ENGINE) network inspect $(NET) >/dev/null 2>&1; then \
	  $(CONTAINER_ENGINE) network inspect $(NET) 2>/dev/null | grep -q '$(SUBNET)' || { \
	    echo "network '$(NET)' exists but does not carry subnet $(SUBNET) — the pinned node IPs"; \
	    echo "  (10.89.0.x) cannot be assigned in it. It was probably created by an older version"; \
	    echo "  of this Makefile, or by hand. Remove it and let this target recreate it:"; \
	    echo "      make containers-down && $(CONTAINER_ENGINE) network rm $(NET) && make net"; \
	    exit 1; }; \
	else \
	  $(CONTAINER_ENGINE) network create --subnet $(SUBNET) $(NET); \
	fi

secrets-dir:
	mkdir -p $(SECRETS)

clean-secrets: containers-down ## Wipe the captured login (./secrets) + login container (then: make login -> capture-login)
	-$(CONTAINER_ENGINE) rm -f $(LOGIN) 2>/dev/null || true
	rm -rf $(SECRETS)
	@echo "Wiped $(SECRETS) and the login container. Next: make login && make capture-login"

login: build-image net secrets-dir ## Start a VNC container for the one-time Sync login
	-$(CONTAINER_ENGINE) rm -f $(LOGIN) 2>/dev/null || true
	$(CONTAINER_ENGINE) run -d --name $(LOGIN) --network $(NET) \
	  -p $(VNC_PORT):5900 \
	  -v $(SECRETS):/secrets:rw $(IMAGE_TAG)
	@echo
	@echo "VNC ready at localhost:$(VNC_PORT) (password: obsidian); TestVault opens automatically."
	@echo "  1. enable CLI: Settings > General > Advanced > Command line interface"
	@echo "  2. Account: sign in to your Obsidian account"
	@echo "  3. Sync: connect/create the TEST remote vault, set 'Create conflict file'"
	@echo "  4. wait for full sync, then: make capture-login"

capture-login: ## Copy the login out of the container into ./secrets, then stop it
	$(CONTAINER_ENGINE) exec $(LOGIN) sh -c '\
	  mkdir -p /secrets/config /secrets/vault && \
	  cp -a /root/.config/obsidian/. /secrets/config/ && \
	  cp -a /root/vaults/TestVault/.obsidian/. /secrets/vault/'
	$(CONTAINER_ENGINE) rm -f $(LOGIN)
	@echo "Captured login into $(SECRETS) (git-ignored). Next: make containers-up"

# Pinned per-node IP (see src/isolate.ts's nodeIp — same scheme, kept in sync): node number from
# the trailing digits of its name; X = 100+number; IP 10.89.0.<X>, inside obsidian-net's explicit
# 10.89.0.0/24 subnet. Applied at every `$(CONTAINER_ENGINE) run`/`network connect` for a node, so
# a reconnect restores the SAME address the container has had since its very first start and its
# established connections to Sync resume instead of resetting. The MAC is deliberately left to the
# engine — see docs/DESIGN.md.
NODE_ADDR = num=$${n\#n}; addr=$$((100+num)); ip=10.89.0.$$addr

node1: build-image net ## Run a single node (n1) with VNC published, for inspection/debugging
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture-login"; exit 1; }
	-$(CONTAINER_ENGINE) rm -f n1 2>/dev/null || true
	@n=n1; $(NODE_ADDR); \
	  $(CONTAINER_ENGINE) run -d --name n1 --hostname n1 --network $(NET) --ip $$ip \
	    -p $(VNC_PORT):5900 -v $(SECRETS):/secrets:ro $(IMAGE_TAG)
	@scripts/wait-node.sh n1
	@echo "n1 ready. Inspect via VNC: vnc://localhost:$(VNC_PORT) (password: obsidian)."

containers-up: build-image net ## Launch n1 + n2 (each seeds from ./secrets; VNC published per node)
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture-login"; exit 1; }
	@port=$(VNC_PORT); for n in $(CONTAINER_NODES); do \
	  $(CONTAINER_ENGINE) rm -f $$n 2>/dev/null || true; \
	  $(NODE_ADDR); \
	  echo "starting $$n (VNC localhost:$$port, $$ip)"; \
	  $(CONTAINER_ENGINE) run -d --name $$n --hostname $$n --network $(NET) --ip $$ip \
	    -p $$port:5900 -v $(SECRETS):/secrets:ro $(IMAGE_TAG); \
	  port=$$((port+1)); \
	done
	@for n in $(CONTAINER_NODES); do scripts/wait-node.sh $$n; done
	@echo "nodes ready: $(CONTAINER_NODES). VNC from localhost:$(VNC_PORT) (password: obsidian). Then: make run"

solo-check:
	@echo "solo-check: inspecting containers on $(NET)…$(if $(ENGINE_GUARD),, (no 'timeout' found — install coreutils for a hang guard))"
	@# Isolation guard: every node Syncs to the same vault, so a stray
	@# container on the test network would confound the run. Abort if anything running
	@# isn't one of the intended CONTAINER_NODES. The $(CONTAINER_ENGINE) call is time-bounded ($(ENGINE_GUARD))
	@# so a wedged $(CONTAINER_ENGINE) API fails fast with a hint instead of hanging silently.
	@names=$$($(ENGINE_GUARD) $(CONTAINER_ENGINE) ps --filter network=$(NET) --format '{{.Names}}'); rc=$$?; \
	  if [ $$rc -eq 124 ]; then \
	    echo "$(CONTAINER_ENGINE) unresponsive (timed out after $(ENGINE_TIMEOUT)s) — its VM may be wedged."; \
	    echo "  podman: 'podman machine stop && podman machine start'   docker: restart Docker Desktop"; exit 1; fi; \
	  if [ $$rc -ne 0 ]; then \
	    echo "$(CONTAINER_ENGINE) ps failed (rc=$$rc) — is the engine running?"; \
	    echo "  podman: 'podman machine start'   docker: start Docker Desktop / the docker daemon"; exit 1; fi; \
	  for c in $$names; do \
	    echo " $(CONTAINER_NODES) " | grep -q " $$c " || { \
	      echo "stray container '$$c' running on $(NET) — stop it first (e.g. 'make containers-down')"; exit 1; }; \
	  done
	@# Warn when reusing long-lived nodes (accumulated vault/conflict cruft can
	@# skew a run); 'make containers-up' recreates them fresh from the captured login.
	@for n in $(CONTAINER_NODES); do \
	  up=$$($(ENGINE_GUARD) $(CONTAINER_ENGINE) ps --filter "name=^$$n$$" --format '{{.RunningFor}}' 2>/dev/null); \
	  [ -n "$$up" ] && echo "[warn] reusing existing container $$n (up $$up) — run 'make containers-up' for a fresh start" || true; \
	done

# Re-pinning the IP is what keeps a reconnect a link blip rather than a network reset (see
# scripts/check-net.sh); `--ip` is honoured by both engines, so nothing here is engine-specific.
reconnect-nodes: ## Reconnect all CONTAINER_NODES to the network (fixes a node left detached by an interrupted soak)
	@for n in $(CONTAINER_NODES); do \
	  $(NODE_ADDR); \
	  $(ENGINE_GUARD) $(CONTAINER_ENGINE) network connect --ip $$ip $(NET) $$n 2>/dev/null && echo "reconnected $$n ($$ip)" || echo "$$n already connected (or absent)"; \
	done

# run/campaign/soak depend on `reconnect`: a Ctrl-C'd soak can leave a node detached (a `D`
# with no matching `C`), and partitions are always per-rep, so every node should be attached
# at the start of a run. (Not folded into `net`: that runs before containers exist.)
run: solo-check reconnect-nodes ## Run ONE history: generated, or HISTORY=<dsl> (REPEAT=N; STEPS=K runs only its first K ops)
	npm run start -- $(RUN_FLAGS)

campaign: solo-check reconnect-nodes ## Run HISTORIES histories and tally the error rate (HISTORIES=N FORCED_TURNS=... OPS=...)
	npm run start -- --histories $(or $(HISTORIES),20) $(RUN_FLAGS)

soak: solo-check reconnect-nodes ## Run until stopped (Ctrl-C); DURATION_MIN=N for a fixed span. HISTORY=<dsl> soaks that one history
	npm run start -- --histories 0 $(RUN_FLAGS)

# RUNS_PREFIX-aware path to the runs/ tree, so analyze/clean-runs/clean-data stay consistent
# with wherever `make run`/`soak` (via --runs-prefix) put it.
RUNS_DIR := $(if $(RUNS_PREFIX),$(RUNS_PREFIX)/runs,runs)

analyze: ## Aggregate runs/ into runs/analysis.md (state tables by outcome, sync-time distribution)
	npm run analyze -- $(RUNS_DIR)

generate-histories: ## Print N generated histories without running them (N=20; honours FORCED_TURNS/OPS/NOTES/PARTITION_PROB)
	npm run start -- --generate $(or $(N),20) $(RUN_FLAGS)

# Most of RUN_FLAGS (turns/ops/notes/pause-prob/isolator/...) doesn't apply to an already-concrete
# HISTORY, hence its own smaller flags var.
REPRO_FLAGS = --network $(NET) \
  $(if $(OBSIDIAN_BIN),--bin $(OBSIDIAN_BIN)) \
  $(if $(LOCAL_BIN),--local-bin $(LOCAL_BIN)) \
  $(if $(LOCAL_NODE_ID),--local-node-id $(LOCAL_NODE_ID)) \
  $(if $(RUN_ID),--run-id $(RUN_ID)) \
  $(if $(WAIT_CAP_SEC),--wait-cap-sec $(WAIT_CAP_SEC)) \
  $(if $(WAIT_POLL_SEC),--wait-poll-sec $(WAIT_POLL_SEC)) \
  $(if $(OUT),--out $(OUT))

repro: ## Generate a standalone bash script reproducing HISTORY=<dsl> by hand (does not touch nodes)
	npm run repro -- --history "$(HISTORY)" $(REPRO_FLAGS)

clean-notes: solo-check ## Delete the harness's notes (the bughunt/ folder only) on all container nodes (nodes must be up)
	npm run clean-notes -- --nodes $(CONTAINER_NODES_CSV)

clean-runs: ## Wipe local run results/logs (rm -rf runs/)
	rm -rf $(RUNS_DIR)

clean-data: clean-notes ## Fresh slate for a soak: clear the harness's notes (bughunt/) + wipe runs/ (nodes must be up)
	rm -rf $(RUNS_DIR)

trial: containers-up run ## Clean-slate run: recreate + gate the nodes, then run one history from cold

containers-down: ## Stop + remove n1/n2
	-@for n in $(CONTAINER_NODES); do $(CONTAINER_ENGINE) rm -f $$n 2>/dev/null || true; done

ps: ## List containers on the test network
	$(CONTAINER_ENGINE) ps --filter network=$(NET)

logs: ## Tail Obsidian's log on the first node
	$(CONTAINER_ENGINE) exec $(firstword $(CONTAINER_NODES)) tail -n 80 /var/log/obsidian.log

health: ## Print a node's liveness report + save its screenshot to ./_shot.png (NODE=n1)
	@$(CONTAINER_ENGINE) exec $(NODE) /usr/local/bin/obsidian-healthcheck
	@$(CONTAINER_ENGINE) cp $(NODE):/var/log/obsidian-shot.png ./_shot.png && echo "screenshot -> ./_shot.png"

clean-images: containers-down ## Remove ALL node images (every version) + the test network (keeps ./secrets)
	-$(CONTAINER_ENGINE) rm -f $(LOGIN) 2>/dev/null || true
	@# Every version-tagged build, not just the currently-pinned one — `make list-images` lists them.
	-@ids=$$($(CONTAINER_ENGINE) images --format '{{.Repository}}:{{.Tag}}' | grep '^$(IMAGE):' || true); \
	  [ -n "$$ids" ] && $(CONTAINER_ENGINE) rmi $$ids 2>/dev/null || true
	-$(CONTAINER_ENGINE) network rm $(NET) 2>/dev/null || true
	@echo "Note: ./secrets kept. Run clean-secrets to discard the captured login."

# ---- Obsidian version management -------------------------------------------

# Read from Obsidian's OWN update manifest — the same file the app's updater consults — rather
# than the GitHub API, which is rate-limited to 60 requests/hour for unauthenticated callers and
# would occasionally answer with an error instead of a version. Recursive (`=`, not `:=`) so the
# network call happens only inside the recipes that ask for it, never on every `make`.
FETCH_LATEST = curl -fsSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json 2>/dev/null \
	    | sed -n 's/.*"latestVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1

list-images: ## List the node images built so far, one per Obsidian version
	@$(CONTAINER_ENGINE) images --filter reference='$(IMAGE)' --format '  {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' \
	  | sort || true
	@echo "  (currently pinned: OBSIDIAN_VERSION=$(OBSIDIAN_VERSION))"

obsidian-latest: ## Check the newest Obsidian release upstream against the pinned OBSIDIAN_VERSION
	@latest=$$($(FETCH_LATEST)); \
	  if [ -z "$$latest" ]; then echo "could not read the upstream release manifest (offline?)"; exit 1; fi; \
	  if [ "$$latest" = "$(OBSIDIAN_VERSION)" ]; then \
	    echo "up to date: pinned $(OBSIDIAN_VERSION) is the latest release"; \
	  else \
	    echo "pinned:  $(OBSIDIAN_VERSION)"; \
	    echo "latest:  $$latest"; \
	    echo; \
	    echo "To move the pin:"; \
	    echo "    make obsidian-upgrade       # rewrites OBSIDIAN_VERSION here, then: make containers-up"; \
	    echo "Or try it without moving the pin at all:"; \
	    echo "    make containers-up OBSIDIAN_VERSION=$$latest"; \
	  fi

# Deliberately a SEPARATE target from obsidian-latest, which stays a read-only query. This one
# edits a git-tracked file, so it should be something you asked for by name, not a side effect of
# checking. `git diff` shows exactly what moved; `git checkout` undoes it.
#
# The version is fetched over the network before being persisted, so it is validated strictly
# (x.y.z, digits only) before it goes anywhere near disk. The file is consumed by make and passed
# to `docker build --build-arg`, so a manifest answering with something unexpected must not be
# able to put arbitrary text there.
obsidian-upgrade: ## Rewrite ./obsidian-version to the newest upstream release
	@latest=$$($(FETCH_LATEST)); \
	  if [ -z "$$latest" ]; then echo "could not read the upstream release manifest (offline?)" >&2; exit 1; fi; \
	  echo "$$latest" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$$' \
	    || { echo "refusing to write an implausible version from the network: '$$latest'" >&2; exit 1; }; \
	  if [ "$$latest" = "$(OBSIDIAN_VERSION)" ]; then \
	    echo "already pinned to $(OBSIDIAN_VERSION), the latest release — nothing to do"; exit 0; fi; \
	  echo "$$latest" > $(VERSION_FILE); \
	  echo "OBSIDIAN_VERSION: $(OBSIDIAN_VERSION) -> $$latest   (in $(VERSION_FILE); 'git diff' to review)"; \
	  echo; \
	  echo "Next:  make containers-up      # builds the new image and relaunches the nodes on it"; \
	  echo "       make check-assumptions  # an upgrade is exactly when obsidian-cli output drifts"

# ---- engine sanity ---------------------------------------------------------

check-net: net ## Verify a D/C reconnect is a brief blip (<1s, pinned IP) on this engine — run after an engine change
	@scripts/check-net.sh $(or $(ROUNDS),3) $(or $(OUTAGE),10) $(or $(BUDGET),1.0)

# The deliberate "is the apparatus still what we think it is" pass — engine, network, image,
# Obsidian version, the D/C blip property, and whether obsidian-cli's output still parses. Rare and
# thorough rather than quick, and deliberately NOT a dependency of run/containers-up: it exists for
# coming back to the project, or after an Obsidian/engine update. OBSIDIAN_VERSION/IMAGE/NET/SUBNET
# reach the script through the environment; CONTAINER_ENGINE is already exported at the top.
check-assumptions: net ## Check everything the harness assumes about its environment (engine, image, D/C blip, CLI formats)
	@ips=""; for n in $(CONTAINER_NODES); do $(NODE_ADDR); ips="$$ips $$ip"; done; \
	  OBSIDIAN_VERSION=$(OBSIDIAN_VERSION) IMAGE=$(IMAGE) NET=$(NET) SUBNET=$(SUBNET) \
	  NODE_IPS="$$ips" NODES=$(CONTAINER_NODES_CSV) $(if $(ROUNDS),ROUNDS=$(ROUNDS)) \
	  scripts/check-assumptions.sh
