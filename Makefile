# Docket — developer shortcuts
#
# Run `make` or `make help` to see available targets. Everything delegates to
# `uv` or `bun` so the underlying tools stay discoverable.

SHELL := /bin/bash
.DEFAULT_GOAL := help

FRONTEND := frontend
ENV_FILE := .env

## ---------- host (no containers) ----------

.PHONY: install
install: ## install backend + frontend deps (uv sync, bun install)
	uv sync
	cd $(FRONTEND) && bun install

.PHONY: backend
backend: ## run backend on the host (docket serve → 127.0.0.1:8765)
	uv run docket serve

.PHONY: tui
tui: ## run the Textual TUI on the host
	uv run docket

.PHONY: frontend
frontend: ## run frontend dev server on the host (vite → localhost:3000)
	@set -a; [ -f $(ENV_FILE) ] && . ./$(ENV_FILE); set +a; \
	 cd $(FRONTEND) && bun run dev

.PHONY: dev
dev: ## run backend + frontend concurrently (Ctrl-C stops both)
	@set -a; [ -f $(ENV_FILE) ] && . ./$(ENV_FILE); set +a; \
	 trap 'kill 0' EXIT INT TERM; \
	 uv run docket serve & \
	 (cd $(FRONTEND) && bun run dev) & \
	 wait

.PHONY: frontend-build
frontend-build: ## build the static SPA bundle (frontend/dist)
	cd $(FRONTEND) && bun run build

.PHONY: bundle-spa
bundle-spa: frontend-build ## copy the built SPA into src/docket/frontend_dist/ for wheel packaging
	rm -rf src/docket/frontend_dist
	cp -R $(FRONTEND)/dist src/docket/frontend_dist

.PHONY: serve
serve: frontend-build ## build the SPA, then run the backend serving it at http://127.0.0.1:8765
	uv run docket serve

.PHONY: wheel
wheel: bundle-spa ## build a single-artifact wheel with the SPA bundled inside
	uv build --wheel

## ---------- quality ----------

.PHONY: test
test: ## run backend pytest suite
	uv run pytest

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
check: lint typecheck test ## lint + typecheck + test across both trees

.PHONY: gen-api
gen-api: ## regenerate frontend OpenAPI types from the running backend
	cd $(FRONTEND) && bun run gen:api

.PHONY: stats
stats: ## show LOC stats using cloc (git-tracked files only)
	@command -v cloc >/dev/null 2>&1 || { echo "cloc not found (install with: brew install cloc)"; exit 1; }
	@cloc --vcs=git .

## ---------- maintenance ----------

.PHONY: clean
clean: ## remove local caches and the SPA build output
	rm -rf $(FRONTEND)/dist $(FRONTEND)/.vite src/docket/frontend_dist
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .mypy_cache .pytest_cache .ruff_cache

.PHONY: env
env: ## create .env from .env.example if missing, with a fresh token
	@if [ -f $(ENV_FILE) ]; then echo "$(ENV_FILE) already exists"; exit 0; fi
	@cp .env.example $(ENV_FILE)
	@token=$$(openssl rand -hex 32); \
	  sed -i.bak "s|^DOCKET_API_TOKEN=.*|DOCKET_API_TOKEN=$$token|" $(ENV_FILE) && \
	  rm $(ENV_FILE).bak
	@echo "wrote $(ENV_FILE) with a fresh DOCKET_API_TOKEN"

.PHONY: help
help: ## list available targets
	@awk 'BEGIN { FS = ":.*## "; printf "Usage: make \033[36m<target>\033[0m\n\nTargets:\n" } \
	     /^[a-zA-Z0-9_.-]+:.*## / { printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2 } \
	     /^## -/ { printf "\n%s\n", $$0 }' $(MAKEFILE_LIST)
