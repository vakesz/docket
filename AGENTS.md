# Docket — contract for human and AI contributors

This file is the load-bearing reference for anyone (or anything) editing the codebase. It captures invariants that aren't visible from a single grep — architecture rules enforced by tests, the proposal-first mutation pattern, and conventions the wider tooling depends on. Read it before making non-trivial changes.

## Project Snapshot

- Python 3.12+, multi-surface: **Typer CLI** (`src/docket/cli/`), **Textual TUI** (`src/docket/cli/tui/`), **FastAPI HTTP** (`src/docket/api/`), and a **React + Vite SPA** in `frontend/` that consumes `/openapi.json`. Vite emits the built SPA directly into `src/docket/frontend_dist/`, and the FastAPI app serves it from there both in dev and in the wheel — one process, one origin (`src/docket/api/spa.py`). There is no separate frontend dev server; iterate by re-running `make frontend-build` (or `make serve`) and refreshing the browser.
- Layered ports-and-adapters: surfaces in `cli/` and `api/`, canonical types in `core/`, orchestration in `core/services/` and `agent/`, adapters in `providers/`, `storage/`, `config/`, `telemetry/`.
- Multi-provider. Built-ins: `azure_devops`, `github`, `github_stub`. Third-party providers register via the `docket.providers` entry-point group (`src/docket/providers/registry.py`).
- Runtime is **local-first** and **project-scoped**. Items cache in SQLite; project metadata, prompts, and MCP server configs live under XDG-managed paths.
- Primary safety property: **proposal-first mutation**. Cache and chat locally; render a diff; require explicit confirmation before any provider write.

## Commands

Backend (Python / `uv`):

```bash
uv sync

uv run docket                      # default: open the TUI
uv run docket open --provider <p>
uv run docket --help
uv run docket status [-v]
uv run docket setup [--step=<name>]
uv run docket setup provider list|add|remove
uv run docket sync [--full]
uv run docket list --kind story
uv run docket show <id>
uv run docket transition <id> start_work [--dry-run]
uv run docket patch <id> --from-file body.md [--dry-run]
uv run docket new task --title "Title"
uv run docket project|memory|source|mcp ...
uv run docket serve [--host …] [--port …] [--no-chat] [--read-only]

uv run pytest
uv run pytest tests/integration/test_api_items.py
uv run pytest tests/unit/test_import_boundary.py
uv run pytest tests/pilot/test_tui_pilot.py
uv run pytest -k "pattern"

uv run ruff check . && uv run ruff format .
uv run mypy src
```

Frontend (`bun` in `frontend/`):

```bash
cd frontend && bun install
cd frontend && bun run build       # emits into ../src/docket/frontend_dist/
cd frontend && bun run typecheck   # tsc --noEmit
cd frontend && bun run lint        # biome check
cd frontend && bun run gen:api     # regenerate OpenAPI types from running backend
```

Cross-tree shortcuts (`Makefile`):

```bash
make install        # uv sync + bun install
make frontend-build  # build the SPA (vite emits straight into src/docket/frontend_dist/)
make serve           # build the SPA, then run the backend (mints a bootstrap token into config.toml on first run)
make token           # print the bearer token from the workspace config.toml
make wheel           # build a single-artifact wheel with the SPA bundled inside
make check           # lint + typecheck + test across both trees
make clean-workspace # delete ./.docket-dev (dev workspace) — wipes config, db, logs
```

All `make` targets run docket against `WORKSPACE=./.docket-dev` via the top-level `docket --workspace=DIR` flag. That flag rewrites `XDG_CONFIG_HOME/STATE_HOME/CACHE_HOME/DATA_HOME` to point under `DIR/{config,state,cache,data}/` *before* the path snapshot in `src/docket/config/paths.py:_pre_workspace_xdg` is captured, so external tools (`gh`, `az`) still see the user's real shell exports. Override with `make serve WORKSPACE=/tmp/foo` to point at any other directory.

## Non-Negotiable Rules

1. **No concrete-provider imports in `core/`, `storage/`, `agent/`, `api/`.** They speak only to the `WorkItemProvider` Protocol, provider specs, or the registry — never `AzureDevOpsProvider` / `GitHubProvider` directly. Enforced by `tests/unit/test_import_boundary.py`. See `src/docket/providers/base.py`, `src/docket/providers/registry.py`.
2. **Translate provider-native kinds and states at the boundary.** The rest of the app runs on canonical enums (`ItemKind`, `ItemState`, `TransitionIntent`). Translation lives in each provider's `state_map.py` (`src/docket/providers/{azure_devops,github,github_stub}/state_map.py`); the canonical types are in `src/docket/core/model.py`.
3. **Never call `provider.transition` / `patch_description` / `upload_attachment` / `create_item` from a surface.** All provider writes route through `src/docket/core/services/mutation_service.py`.
4. **Every write is proposal-first.** Build a `Proposal`, render a diff, get confirmation, then execute via `mutation_service.confirm(...)`. Files: `src/docket/core/mutation.py`, `src/docket/core/services/mutation_service.py`, `src/docket/core/services/proposal_store.py`.
5. **Agent mutating tools only stage proposals.** Both work-item and project-memory tools (`src/docket/agent/mutating_tools.py`, `src/docket/agent/memory_tools.py`) build proposals; they never write to providers or SQLite directly.
6. **Project sources are read-only for the agent.** The agent gets `list_sources` / `read_source` / `search_sources` only (`src/docket/agent/source_tools.py`). Source writes are human-driven through CLI/TUI/API → repo (`src/docket/storage/repos/source_repo.py`, `src/docket/cli/commands/source.py`, `src/docket/api/routes/source.py`, `src/docket/cli/tui/widgets/source_pane.py`).
7. **Keep the prompt prefix byte-stable.** No timestamps, usernames, scope labels, or other runtime-only text in the system+snapshot prefix or the prompt cache collapses. See `src/docket/agent/prompt.py`, `src/docket/agent/tools.py`, `src/docket/agent/factory.py`; covered by `tests/integration/test_prompt_loader.py`.
8. **Preserve agent tool registration order.** The ordered tool schema list is part of the prefix cache key. Current order (`src/docket/agent/factory.py:build_tool_registry`):
   1. readonly: items → PRs → commits/CI (`src/docket/agent/tool_defs.py`)
   2. link tools (`src/docket/agent/link_tools.py`)
   3. memory readonly (project-scoped)
   4. source readonly (project-scoped)
   5. MCP tools (project-scoped, stripped in read-only)
   6. mutating: provider mutations (stripped in read-only)
   7. memory mutations (project-scoped, stripped in read-only)

   Pinned by `tests/unit/test_tool_registration_order.py`. Reorder = invalidate every open conversation's prompt cache.
9. **SQLite is a cache, not the system of record.** Sync from the provider, refresh cached rows after a confirmed write (`src/docket/core/services/sync_service.py`, `src/docket/core/services/mutation_service.py:_refresh_cache`).
10. **No hidden runtime singletons.** Pass `conn`, `provider`, `paths`, `config`, `provider_key`, `project_id`, runtime state explicitly through `cli.context.Context` or `app.state.runtime` (`src/docket/cli/context.py`, `src/docket/api/app.py`, `src/docket/api/runtime.py`, `src/docket/api/agent_rebuild.py`).
11. **Read-only mode blocks every mutation entry point and strips mutating tools** — agent + MCP. Not just a warning. See `src/docket/cli/guard.py`, `src/docket/api/deps.py:require_not_read_only`, `src/docket/agent/factory.py`, `src/docket/cli/tui/app.py`. Tests: `tests/integration/test_cli_read_only.py`, `tests/integration/test_api_read_only.py`, `tests/pilot/test_read_only_mode.py`, `tests/integration/test_mcp.py`.
12. **Watchlist rows are independent of `items(id)`.** Pinned ids may outlive the current cache scope (`src/docket/storage/schema.py`, `tests/integration/test_watchlist_repo.py`).
13. **Provider/project switches must rebuild the agent** so tool closures rebind to the new `(provider, provider_key, project_id)` tuple (`src/docket/api/agent_rebuild.py`, `src/docket/cli/tui/app.py`). On the API side, `RuntimeState.switch_provider` triggers `_rebind_mcp_locked` so the MCP fleet follows the project; scope switches do **not** rebind (the fleet is per-provider/project, not per-view).

## Mutation Surface Pattern

This is the same shape across CLI, TUI, API, and agent-confirmed flows: stage a proposal, then execute through `mutation_service.confirm(...)`. CLI commands wrap it via `apply_mutation` (`src/docket/cli/confirm.py`):

```python
from docket.cli.confirm import apply_mutation
from docket.core.services import mutation_service

proposal = mutation_service.propose_transition(
    ctx.conn,
    item_id,
    intent,
    provider_key=ctx.active_provider,
)
apply_mutation(
    ctx.conn,
    ctx.provider,
    proposal,
    confirm_title=f"Transition {item_id} ({intent.value})",
    dry_run=dry_run,
    on_success=lambda r: f"[green]✓ {item_id} → {r.item.state.value}[/green]",
    provider_key=ctx.active_provider,
)
```

Available proposal builders in `mutation_service`: `propose_transition`, `propose_description_patch`, `propose_attachment`, `propose_comment`, `propose_memory_write`, `propose_memory_delete`. New-item creation uses the same store via the agent's `propose_new_item` tool (`src/docket/agent/mutating_tools.py`).

Surfaces:

- **CLI:** `src/docket/cli/confirm.py:apply_mutation` + commands under `src/docket/cli/commands/`.
- **TUI:** confirm modals in `src/docket/cli/tui/widgets/diff_modal.py` + `batch_diff_modal.py`; review flow in `src/docket/cli/tui/review_flow.py`.
- **API:** `src/docket/api/routes/mutations.py` for confirm; proposal builders are called by the routes that own each surface (`items.py`, `memory.py`, etc.).
- **Agent:** `src/docket/agent/mutating_tools.py` stages proposals only; the human still confirms via the surface that owns the chat session.

## Architecture Map

```text
docket / docket open / docket serve
        |
        v
cli.app / cli.commands.open / cli.commands.serve
        |
        v
cli.context.prepare[_or_wizard]
  resolve paths -> load env -> init logging -> load config -> init SQLite -> build providers
        |
        +--> project_service mirror/activate
        |
        +--> Textual TUI (DocketApp)
        |      reads SQLite cache
        |      syncs via sync_service
        |      chats via conversation_service -> AgentLoop
        |      mutates via mutation_service -> confirm modals
        |      edits memory/source via storage repos, MCP via mcp_service
        |
        +--> FastAPI app  <-- React frontend (frontend/, consumes /openapi.json)
               routes -> deps/runtime -> services
               SSE chat -> conversation_service
               proposal endpoints -> mutation_service.confirm
               runtime admin -> prompts/settings/providers/scopes/projects/memory/source/mcp
```

Forbidden edges:

- `core/`, `storage/`, `agent/`, `api/` → concrete provider modules
- Surface adapters → provider write methods
- Dynamic prompt-prefix fields before the cache boundary
- Agent → source mutation paths

Aspirational direction (consistent with current refactors, not a hard rule):

- `cli/`, `cli/tui/`, `api/routes/` stay thin — parse input, call one service, map result back.
- Provider onboarding and plugin discovery centralize in registry/setup services, not scattered across surfaces.
- Runtime rebind, config writes, and project-scoped admin live in shared services so TUI and HTTP can't drift.
- `config/` stays file/path primitives + schemas + setup orchestration; not a dumping ground.

## Global Invariants

- **Prompt hot reload is mtime-keyed.** Edits to `prompts/system_base.md` or `prompts/kind_<kind>.md` apply on the next turn (`src/docket/agent/prompt.py`, `src/docket/agent/prompt_templates.py`).
- **Conversation compaction** summarizes older messages into a synthetic `system` row and flips `messages.compacted = 1` on originals so transcripts stay complete while the live prompt history stays short (`src/docket/core/services/compaction_service.py`, `src/docket/storage/repos/message_repo.py`).
- **External item changes are injected** back into active conversations as system messages so the assistant doesn't keep reasoning over stale ticket state (`src/docket/core/services/external_update_service.py`).
- **Source documents are excluded from the always-on prefix.** The agent reads them on demand through tools, so source edits never invalidate the prompt cache (`src/docket/core/services/source_service.py`, `src/docket/storage/repos/source_repo.py`).
- **MCP server config is per-project**, persisted in `config.toml`. Config edits do not auto-mutate a live manager — surfaces explicitly rebind (`src/docket/core/services/mcp_service.py`, `src/docket/agent/mcp/manager.py`, `src/docket/api/routes/mcp.py`, `src/docket/api/runtime.py:_rebind_mcp_locked`).
- **Bootstrap HTTP mode** is a separate minimal app exposing only `/health` and `/setup/*` until `config.toml` exists (`src/docket/api/bootstrap_app.py`, `src/docket/api/routes/setup.py`). Setup and live-mode provider routes share DTO assembly via `src/docket/api/_provider_setup.py`.
- **All backend routes live under `/api/*`** so the SPA catch-all in `src/docket/api/spa.py` can safely return `index.html` for everything else. New routes that aren't under `/api/*` will be shadowed by the SPA. The dist directory is resolved in order: `DOCKET_FRONTEND_DIST` env (tests) → `<docket package>/frontend_dist/` (vite's `build.outDir`, populated by `bun run build` / `make frontend-build`; same path in dev and wheel install). The bearer token is injected into `index.html` at request time as `window.__DOCKET_TOKEN__`; cached by mtime, no restart needed after a rebuild.
- **Telemetry is on by default**, one JSON object per line into `<paths.log_dir>/docket.log` (rotating 1 MB × 3) at `DEBUG`. The on-disk log is the only place some worker-thread tracebacks surface during a TUI session — verbosity is intentional (`src/docket/telemetry/logging.py`, `src/docket/cli/context.py`, `src/docket/config/models.py`).

## Testing

- **Layout by intent.** `tests/unit/` for pure-Python units and architectural guards; `tests/integration/` for DB/FastAPI/Typer/service coverage; `tests/pilot/` for Textual pilot flows.
- **Stack.** `pytest`, `pytest-asyncio` in auto mode (see `pyproject.toml`), `pytest-recording` for live Azure DevOps coverage, Textual `app.run_test()` for the TUI.
- **Favor fakes and pilot-style tests** over private widget or CSS assertions. `tests/fakes/provider.py` (FakeProvider), `tests/fakes/llm.py` (scripted LLM), `tests/fakes/mcp_server.py`. Examples: `tests/pilot/test_tui_chat_pilot.py`, `tests/integration/test_api_conversation.py`.
- **Architecture tests are not optional.** `tests/unit/test_import_boundary.py`, `tests/unit/test_state_map_reverse.py`, `tests/unit/test_tool_registration_order.py`, `tests/integration/test_github_stub_provider.py`. If they fail, fix the leak — don't relax the test.
- **When you change agent tooling, prompt loading, or runtime rebinding**, cover both the pure service behavior and at least one surface-level path.

### Test fixtures and conventions

- **`tmp_xdg`** (`tests/conftest.py`) sandboxes XDG paths under a temp root. Use it whenever a test touches config, prompts, logs, or the SQLite cache.
- **`_in_memory_keyring`** (autouse, `tests/conftest.py`) installs a per-test in-memory `keyring` backend so `set_llm_api_key(...)` never touches the developer's real macOS Keychain / Linux Secret Service. Architecturally this works because only `docket.config.secrets` imports `keyring` — enforced by `tests/unit/test_import_boundary.py:test_keyring_only_imported_by_secrets_module`.
- **Prompt-loader tests** reset module-level loader state before and after each case so prompt overrides don't leak across the suite (`tests/integration/test_prompt_loader.py`).
- **Bootstrap setup tests** stub the self-restart hook so `/setup/complete` can be exercised without killing the test process (`tests/integration/test_api_setup.py`).
- **TUI tests** mount `DocketApp` with a fake provider via `app.run_test()` and drive behavior with `pilot.press(...)`. No CSS or private-widget assertions. See `tests/pilot/test_tui_pilot.py`, `tests/pilot/test_diff_modal_pilot.py`.
- **API integration tests** are split per route module (`test_api_items.py`, `test_api_conversation.py`, `test_api_mutations.py`, etc.) sharing fixtures from `tests/integration/_api_fixtures.py`. There is no monolithic `test_api.py`.

## Linting and Code Style

- Target Python 3.12 (`pyproject.toml`).
- Ruff is formatter and linter. Selected rule groups: `E`, `F`, `I`, `N`, `UP`, `B`, `SIM`, `RUF`. Line length 100; `E501` ignored.
- Per-file ignores: `tests/**` drops `B`/`SIM`; `src/docket/api/**` and `src/docket/cli/commands/**` drop `B008` because FastAPI `Depends(...)` and Typer `Argument(...)`/`Option(...)` belong in argument defaults.
- Mypy strict, Pydantic plugin enabled. New code carries real types — no `Any` placeholders.

## When in doubt

- **Skim** `src/docket/core/services/mutation_service.py` and `src/docket/agent/factory.py` — they're the spine of the safety story.
- **Run** the architecture tests (`uv run pytest tests/unit/test_import_boundary.py tests/unit/test_tool_registration_order.py tests/unit/test_state_map_reverse.py`) before you push a refactor.
- **Read** [README.md](README.md) for the user-facing tour, and [.docs/FIRST_TIME_SETUP.md](.docs/FIRST_TIME_SETUP.md) for the onboarding walkthrough.
