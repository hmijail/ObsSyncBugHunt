# Single entry point for the Obsidian Sync tester.
#
#   Dev:        make install | typecheck | test | check | smoke | local
#   Containers: make build -> login -> capture -> up -> run    (then: down)
#
# Credentials are captured into ./secrets (git-ignored) and mounted into nodes
# read-only — never baked into an image. Both nodes seed from the same login
# (same device identity = the deliberate clone/collision test).

IMAGE      := obsidian-node
LOGIN      := obsidian-login
NET        := obsidian-net
NODES      := n1 n2
SECRETS    := $(CURDIR)/secrets/obsidian
# Local throwaway vault for `make smoke` / `make local` (override: make local TEST_VAULT=Foo)
TEST_VAULT ?= Throwaway

.DEFAULT_GOAL := help
.PHONY: help install typecheck test check smoke local \
        build net secrets-dir login capture up run down ps logs clean

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

login: build net secrets-dir ## Start a VNC container for the one-time Sync login
	-podman rm -f $(LOGIN) 2>/dev/null || true
	podman run -d --name $(LOGIN) --network $(NET) \
	  -e CAPTURE=1 -p 5900:5900 --shm-size=1g \
	  -v $(SECRETS):/secrets:rw $(IMAGE)
	@echo
	@echo "VNC ready at localhost:5900. In the session:"
	@echo "  open /root/vaults/TestVault as a vault, log into Sync, link the TEST"
	@echo "  remote vault, set conflict handling = 'Create conflict file', sync fully."
	@echo "Then: make capture"

capture: ## Copy the login out of the container into ./secrets, then stop it
	podman exec $(LOGIN) sh -c '\
	  mkdir -p /secrets/config /secrets/vault && \
	  cp -a /root/.config/obsidian/. /secrets/config/ && \
	  cp -a /root/vaults/TestVault/.obsidian/. /secrets/vault/'
	podman rm -f $(LOGIN)
	@echo "Captured login into $(SECRETS) (git-ignored). Next: make up"

up: build net ## Launch n1 + n2 (each seeds from ./secrets, read-only)
	@test -d $(SECRETS)/config || { echo "No captured login. Run: make login && make capture"; exit 1; }
	@for n in $(NODES); do \
	  podman rm -f $$n 2>/dev/null || true; \
	  echo "starting $$n"; \
	  podman run -d --name $$n --hostname $$n --network $(NET) --shm-size=1g \
	    -v $(SECRETS):/secrets:ro $(IMAGE); \
	done
	@echo "nodes up: $(NODES). Give them time to sync, then: make run"

run: ## Run the convergence test against the nodes (ISOLATOR=sync|network)
	NODES="$(shell echo $(NODES) | tr ' ' ',')" npm run start

down: ## Stop + remove n1/n2
	-@for n in $(NODES); do podman rm -f $$n 2>/dev/null || true; done

ps: ## List containers on the test network
	podman ps --filter network=$(NET)

logs: ## Tail Obsidian's log on the first node
	podman exec $(firstword $(NODES)) tail -n 80 /var/log/obsidian.log

clean: down ## Remove containers, image, network (keeps ./secrets)
	-podman rm -f $(LOGIN) 2>/dev/null || true
	-podman rmi $(IMAGE) 2>/dev/null || true
	-podman network rm $(NET) 2>/dev/null || true
	@echo "Note: ./secrets kept. Remove it manually to discard the captured login."
