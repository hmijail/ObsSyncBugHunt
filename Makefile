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
VERSION_FILE_NODE := .nvmrc

# ---- the Node the project actually runs on ---------------------------------
#
# `.nvmrc` is an inert text file: something has to read it. fnm's usual `fnm env --use-on-cd` reads
# it by hooking `cd`, which only fires in an INTERACTIVE shell that has sourced the hook. Every
# other caller — a make recipe, CI, a cron job, an editor's task runner, an agent driving the repo
# through a non-interactive bash — silently gets whatever `node` happens to be first on PATH. That
# is precisely the "running on a Node nobody chose" this project already warns about, and an
# advisory cannot prevent it.
#
# `fnm exec` needs no hook: it reads .nvmrc itself and runs the command under that version. Routing
# every npm invocation through it makes the pin hold for EVERY caller, which is the property
# .nvmrc always appeared to have and never did. Verified on both sides of the divide: in a plain
# non-interactive shell `node -v` reports 23.6.0 while `fnm exec -- node -v` reports .nvmrc's
# 26.9.0. (It also works where `fnm env` does not — the latter wants a writable multishell dir.)
#
# Exported so scripts/ inherits the same mediated npm rather than reaching for a bare one; each
# script keeps a `:-npm` fallback so running it by hand still works.
#
# THE PROBE ASKS WHETHER fnm CAN ACTUALLY SERVE THE PIN, not merely whether fnm exists. "fnm is
# installed but .nvmrc's version is not" is a real and ordinary state — fnm is commonly installed
# for some other project — and testing only for the binary turned that state into a hard failure of
# every target here. fnm is listed as OPTIONAL in the README and was optional before this mediation
# existed; making it conditionally mandatory would be this change quietly growing a second, unasked
# purpose. So an unusable fnm falls back to plain `npm`, exactly as if it were absent.
#
# ~21ms per make invocation, measured, against ~7ms for a bare `command -v`. Worth it: the cheap
# probe answers the wrong question.
#
# What it must NOT do is fall back SILENTLY, which would be the "running on a Node nobody chose"
# this exists to stop. Absent fnm is the documented optional state and says nothing; fnm that
# cannot serve the pin is a narrow, genuinely-wrong state and warns every time, until one
# `fnm install` fixes it for good.
# fnm's OWN stderr, so the warning names the actual reason rather than guessing at one. It is empty
# on success (verified), which is what lets a single probe be both the test and the explanation.
# The failures are not one condition with one fix — they are at least two, wanting different things:
#
#   "Requested version vX is not currently installed"    the ordinary one. A fresh clone with fnm
#                                                        already installed for some OTHER project,
#                                                        or a pull that moved .nvmrc (this repo did
#                                                        exactly that, 23.6.0 -> 26.9.0) leaving an
#                                                        fnm that has the old version and not the
#                                                        new.            Fix: fnm install
#   "Can't find version in dotfiles"                     no .nvmrc where fnm looked, i.e. make was
#                                                        invoked with CWD outside the repo (`make
#                                                        -f /path/Makefile` rather than `make -C
#                                                        /path`).        Fix: run make from the repo
#
# Calling both "the pin is missing" would have been wrong about the second one, which is why the
# message quotes fnm instead of paraphrasing it.
FNM_WHY := $(shell fnm exec -- true 2>&1 >/dev/null | head -1)
FNM_OK  := $(if $(FNM_WHY),,yes)
NPM     := $(strip $(if $(FNM_OK),fnm exec --,) npm)
export NPM
ifeq ($(FNM_OK),)
ifneq ($(shell command -v fnm 2>/dev/null),)
$(warning fnm is on PATH but cannot run under this directory's pin, so every target here falls back \
to PATH's node ($(shell node -v 2>/dev/null)) — fnm says: $(FNM_WHY))
endif
endif
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
NODES      ?= n1 n2
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
# The CLI inside a node container, as the image installs it. The host's equivalent is LOCAL_BIN
# above; this one is a fixed path because the image is ours.
NODE_CLI   ?= /opt/obsidian/obsidian-cli

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
# Reject unknown command-line variables. `make soak REPAET=5` is otherwise accepted in silence:
# make happily defines an unused REPAET, the recipe expands with no --repeat at all, and the run
# uses the default 10 while you believe it used 5. That is the silent-wrong-experiment failure this
# project keeps tripping over, and it is the ONE thing a make front-end has to do that make does
# not do for free (the npm layer below is already strict — parseArgs rejects unknown --flags).
#
# The accepted set is scraped from this Makefile rather than hand-listed, so it cannot drift: a
# variable the Makefile actually expands somewhere is, by definition, a knob. Renamed variables
# need no special case — an old name is simply not referenced any more, so it lands here as unknown.
# Comment lines are stripped before scraping: a name that appears only in prose (this comment used
# to contain an example, which the scrape then accepted as real) is documentation, not a knob.
# Only `command line` origin is checked: environment variables are a deliberate, supported way to
# set these (see the README), and screening the whole environment would be nothing but noise.
KNOWN_VARS := $(shell sed 's/^[[:space:]]*\#.*//' $(MAKEFILE_LIST) | grep -ohE '\$$[({][A-Z][A-Z0-9_]*[)}]' | tr -d '$$(){}' | sort -u)
GIVEN_VARS := $(foreach v,$(.VARIABLES),$(if $(filter command line,$(origin $(v))),$(v)))
UNKNOWN_VARS := $(filter-out $(KNOWN_VARS),$(GIVEN_VARS))
ifneq ($(UNKNOWN_VARS),)
$(error unknown variable(s) on the command line: $(UNKNOWN_VARS). \
`make help` lists the targets; the README table lists every knob)
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
  $(if $(CD_PROB),--cd-prob $(CD_PROB)) \
  $(if $(REPEAT),--repeat $(REPEAT)) \
  $(if $(DURATION_MIN),--duration-min $(DURATION_MIN)) \
  $(if $(SKIP_HOST_CHECK),--skip-host-check) \
  $(if $(POLL_SEC),--poll-sec $(POLL_SEC)) \
  $(if $(MIN_FLOOR_SEC),--min-floor-sec $(MIN_FLOOR_SEC)) \
  $(if $(CAP_SEC),--cap-sec $(CAP_SEC)) \
  $(if $(FINAL_SETTLE_SEC),--final-settle-sec $(FINAL_SETTLE_SEC)) \
  $(if $(PROBE_SEC),--probe-sec $(PROBE_SEC)) \
  $(if $(RECONNECT_BUDGET_MS),--reconnect-budget-ms $(RECONNECT_BUDGET_MS)) \
  $(if $(RUNS_DIR),--runs-dir $(RUNS_DIR)) \
  $(if $(SKIP_SNAPSHOT),--skip-snapshot) \
  $(if $(LOSS_GRACE_SEC),--loss-grace-sec $(LOSS_GRACE_SEC)) \
  $(if $(SAMPLING),--sampling $(SAMPLING)) \
  $(if $(OPEN_NOTES),--open-notes) \
  $(if $(DISPLAY),--display $(DISPLAY))

.DEFAULT_GOAL := help
.PHONY: help install typecheck test check smoke check-local \
        build-image net secrets-dir clean-secrets login capture-login node1 containers-up solo-check reconnect-nodes unpause-sync run campaign soak analyze generate-histories repro \
        clean-runs clean-notes clean-data clean-images trial containers-down ps logs health \
        list-images obsidian-latest obsidian-upgrade check-net check-assumptions corpus probe-propagation timeline-rep bench-cli

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_-]+:.*## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

# ---- dev -------------------------------------------------------------------

install: ## Reproducible install from the lockfile (npm ci)
	$(NPM) ci
	@$(MAKE) --no-print-directory tools-advice

# Neither tool is required — everything here runs without both — so this only ever prints advice and
# never fails. Said once, at install, because both are the kind of thing you otherwise discover
# indirectly: a hang with no diagnosis, or a run on a Node nobody chose.
.PHONY: tools-advice
tools-advice:
	@$(if $(TIMEOUT_BIN),,\
	  echo "[optional] no 'timeout' on PATH — the engine-hang guard is a no-op, so a wedged Docker/Podman"; \
	  echo "           hangs instead of failing fast.  brew install coreutils")
	@# What this checks changed with NPM above. It used to compare .nvmrc against THIS SHELL's node,
	@# which was the wrong question twice over: a shell on the wrong version is harmless now that
	@# every recipe goes through `fnm exec`, and a shell on the RIGHT version said nothing about
	@# what a cron job or an editor would get. The question that survives is whether the pinned
	@# version is installed at all, because that is the one fnm cannot paper over.
	@want=$$(tr -d '[:space:]' < $(VERSION_FILE_NODE) 2>/dev/null); have=$$(node -v 2>/dev/null | sed 's/^v//'); \
	  if ! command -v fnm >/dev/null 2>&1; then \
	    echo "[optional] no 'fnm' on PATH — .nvmrc ($$want) cannot be enforced, so every target here runs on"; \
	    echo "           whatever node is first on PATH ($$have). engines only requires >=22, so nothing"; \
	    echo "           will complain.  brew install fnm   then: fnm install"; \
	  elif [ -n "$$want" ] && ! fnm exec -- true >/dev/null 2>&1; then \
	    echo "[optional] fnm is on PATH but cannot serve .nvmrc's $$want, so targets here fall back to"; \
	    echo "           PATH's node ($$have) and say so every time:  fnm install"; \
	  fi


typecheck: ## Type-check the project
	$(NPM) run typecheck

test: ## Run unit tests (the oracle)
	$(NPM) test

check: typecheck test ## Type-check + unit tests

smoke: ## Probe the driver against a local throwaway vault (TEST_VAULT=...)
	$(NPM) run smoke -- --vault $(TEST_VAULT)

check-local: ## Single-node pipeline check against a local throwaway vault
	$(NPM) run local -- --vault $(TEST_VAULT)

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
	@echo "Obsidian Sync starts PAUSED on a fresh node. 'make run' (and campaign/soak/clean-notes)"
	@echo "  resumes it; for anything else that talks to the nodes: make unpause-sync"

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

# A fresh node boots with Sync PAUSED and nothing in `containers-up` changes that — wait-node.sh
# accepts `paused` as ready on purpose, so that a Sync that is genuinely stuck stays distinguishable
# from one that simply has not been told to start (see its header).
#
# run/campaign/soak resume it themselves, in run.ts's preflight, and clean-notes does its own. The
# targets that reach the nodes WITHOUT going through those do not: probe-propagation,
# probe-sync-versions, bench-cli, and check-assumptions' steps before its first `npm run start`.
# Nor does a script generated by `make repro`, which has no preflight at all and whose waits give up
# SILENTLY — so a paused node there reports missing tokens, which reads exactly like the data loss
# the repro was written to chase. Run this first when using any of them on fresh containers.
#
# `sync on` on an already-running Sync is a no-op (same property isolate.ts relies on), so this is
# safe to repeat.
unpause-sync: ## Resume Obsidian Sync on all CONTAINER_NODES (a fresh container boots with it paused)
	@for n in $(CONTAINER_NODES); do \
	  printf '%s: ' $$n; \
	  $(ENGINE_GUARD) $(CONTAINER_ENGINE) exec $$n $(NODE_CLI) sync on 2>&1 | head -1; \
	done

# run/campaign/soak depend on `reconnect`: a Ctrl-C'd soak can leave a node detached (a `D`
# with no matching `C`), and partitions are always per-rep, so every node should be attached
# at the start of a run. (Not folded into `net`: that runs before containers exist.)
run: solo-check reconnect-nodes ## Run ONE history: generated, or HISTORY=<dsl> (REPEAT=N; STEPS=K runs only its first K ops)
	$(NPM) run start -- $(RUN_FLAGS)

campaign: solo-check reconnect-nodes ## Run HISTORIES histories and tally the error rate (HISTORIES=N FORCED_TURNS=... OPS=...)
	$(NPM) run start -- --histories $(or $(HISTORIES),20) $(RUN_FLAGS)

soak: solo-check reconnect-nodes ## Run until stopped (Ctrl-C); DURATION_MIN=N for a fixed span. HISTORY=<dsl> soaks that one history
	$(NPM) run start -- --histories 0 $(RUN_FLAGS)

# Where run results live. One variable, and its value IS the directory — it used to be RUNS_PREFIX,
# a PARENT to which "runs" was appended, which needed a second derived variable to say one thing.
# with wherever `make run`/`soak` (via --runs-prefix) put it.
RUNS_DIR ?= runs

analyze: ## Aggregate runs/ into runs/analysis.md (state tables by outcome, sync latency, corpus overview)
	$(NPM) run analyze -- $(RUNS_DIR)

# `make analyze` already writes these same sections into runs/analysis.md — this target just prints
# them on their own, for when that is all you want to look at.
corpus: ## Print just the cross-history sections of the analysis (loss rate by hand-off shape; is the generator still finding new behaviour)
	$(NPM) run corpus -- $(RUNS_DIR)

bench-cli: ## Time obsidian-cli calls vs an empty exec and vs the FS (BENCH_NODE/BENCH_N/BENCH_GAP/BENCH_INTERLEAVED/BENCH_BIN_MS; BENCH_SHOW=1 prints the commands, BENCH_CHECK=1 just the verdict)
	@$(if $(BENCH_N),BENCH_N=$(BENCH_N)) $(if $(BENCH_SHOW),BENCH_SHOW=$(BENCH_SHOW)) \
	 $(if $(BENCH_GAP),BENCH_GAP=$(BENCH_GAP)) $(if $(BENCH_INTERLEAVED),BENCH_INTERLEAVED=$(BENCH_INTERLEAVED)) \
	 $(if $(BENCH_BIN_MS),BENCH_BIN_MS=$(BENCH_BIN_MS)) bash scripts/bench-cli.sh $(BENCH_NODE)

timeline-rep: ## Redraw one rep's timeline from its log (REP=runs/<history>/<rep>.jsonl)
	@test -n "$(REP)" || (echo "usage: make timeline-rep REP=runs/<history>/<rep>.jsonl" && exit 2)
	@$(NPM) run --silent timeline-rep -- $(REP)

probe-propagation: ## Measure where a change's time goes, n1 -> n2 (needs nodes up; HISTORY= to probe a different pattern)
	$(NPM) run probe-propagation -- $(if $(REPEAT),--repeat $(REPEAT)) $(if $(HISTORY),--history '$(HISTORY)') $(if $(NO_SLEEP),--no-sleep)

generate-histories: ## Print N generated histories without running them (N=20; honours FORCED_TURNS/OPS/NOTES/CD_PROB)
	$(NPM) run start -- --generate $(or $(N),20) $(RUN_FLAGS)

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
	$(NPM) run repro -- --history "$(HISTORY)" $(REPRO_FLAGS)

clean-notes: solo-check ## Delete the harness's notes (the bughunt/ folder only) on all container nodes (nodes must be up)
	$(NPM) run clean-notes -- --nodes $(CONTAINER_NODES_CSV)

clean-runs: ## Wipe local run results/logs (rm -rf runs/)
	rm -rf $(RUNS_DIR)

clean-data: clean-notes ## Fresh slate for a soak: clear the harness's notes (bughunt/) + wipe runs/ (nodes must be up)
	rm -rf $(RUNS_DIR)

trial: containers-up run ## Clean-slate run: recreate + gate the nodes, then run one history from cold

# $(LOGIN) is removed here too, not just the nodes. The happy path never needs it — capture-login
# already rm -f's the login container on its way out — but an ABANDONED login (make login, then
# never captured) leaves it running on $(NET), where solo-check correctly refuses to run against
# it as a stray and tells you to "make containers-down". That hint was a dead end while this
# target only knew about $(CONTAINER_NODES): the one command named as the fix could not clear the
# one container that was blocking you. Everything this target removes is recreatable from
# ./secrets (nodes) or by re-running make login, so widening it costs nothing.
containers-down: ## Stop + remove n1/n2 + an abandoned login container
	-@for n in $(CONTAINER_NODES); do $(CONTAINER_ENGINE) rm -f $$n 2>/dev/null || true; done
	-@$(CONTAINER_ENGINE) rm -f $(LOGIN) 2>/dev/null || true

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
