# Docket — developer shortcuts
#
# Run `make` or `make help` to see available targets. Everything delegates to
# `uv` or `bun` so the underlying tools stay discoverable.
#
# Backend targets run docket against a local workspace (./.docket-dev by
# default) so iteration never touches your real ~/.config/docket. Override
# with `make serve WORKSPACE=/tmp/docket-test` to point at any other dir.

SHELL := /bin/bash
.DEFAULT_GOAL := help

FRONTEND := frontend
WORKSPACE ?= ./.docket-dev
DOCKET := uv run docket --workspace=$(WORKSPACE)

## ---------- host (no containers) ----------

.PHONY: install
install: ## install backend + frontend deps (uv sync, bun install)
	uv sync
	cd $(FRONTEND) && bun install

.PHONY: frontend-build
frontend-build: ## build the SPA (vite emits straight into src/docket/frontend_dist/)
	cd $(FRONTEND) && bun run build

.PHONY: serve
serve: frontend-build ## build the SPA, then run the backend at http://127.0.0.1:8765
	$(DOCKET) serve

.PHONY: token
token: ## print the bearer token from the workspace config.toml (mint one via `make serve` if missing)
	$(DOCKET) admin print-token

.PHONY: wheel
wheel: frontend-build ## build a single-artifact wheel with the SPA bundled inside
	uv build --wheel

## ---------- quality ----------

.PHONY: lint
lint: ## lint backend (ruff) and frontend (biome)
	uv run ruff check .
	cd $(FRONTEND) && bun run lint

.PHONY: format
format: ## format backend + frontend in place
	uv run ruff format .
	cd $(FRONTEND) && bun run format

.PHONY: typecheck
typecheck: ## mypy (backend) + tsc (frontend)
	uv run mypy src
	cd $(FRONTEND) && bun run typecheck

.PHONY: check
check: lint typecheck ## lint + typecheck + test across both trees
	uv run pytest

.PHONY: stats
stats: ## show LOC stats using cloc (git-tracked files only)
	@command -v cloc >/dev/null 2>&1 || { echo "cloc not found (install with: brew install cloc)"; exit 1; }
	@cloc --vcs=git .

## ---------- maintenance ----------

.PHONY: clean
clean: ## remove local caches and the SPA build output
	rm -rf $(FRONTEND)/.vite src/docket/frontend_dist $(FRONTEND)/dist
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .mypy_cache .pytest_cache .ruff_cache

.PHONY: clean-workspace
clean-workspace: ## delete the dev workspace ($(WORKSPACE)) — wipes config, db, logs
	rm -rf $(WORKSPACE)

.PHONY: help
help: ## list available targets
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n" } \
	     /^[a-zA-Z0-9_.-]+:.*## / { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	     /^## -/ { printf "\n%s\n", $$0 }' $(MAKEFILE_LIST)
