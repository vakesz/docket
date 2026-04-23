# Docket

## Project Snapshot

- Docket is a Python 3.12+ terminal-first work-item triage app with a Typer CLI, a Textual TUI, a FastAPI HTTP surface, and a React (Vite + Bun + TanStack Router/Query) web client in `frontend/` that consumes the FastAPI OpenAPI schema.
- The package is organized in layered ports-and-adapters style: surfaces in `cli/` and `api/`, canonical domain types in `core/`, workflow orchestration in `core/services/` and `agent/`, and adapters in `providers/`, `storage/`, `config/`, and `telemetry/`.
- The app is multi-provider. Built-ins are `azure_devops`, `github`, and `github_stub`, and third-party providers can register through the `docket.providers` entry-point group (`src/docket/providers/registry.py`).
- The runtime is local-first and project-scoped: remote items are cached in SQLite for fast browsing, while project metadata, prompt files, and MCP server configs live under XDG-managed config paths.
- The primary safety goal is proposal-first mutation: cache and chat locally, render a visible diff, then require explicit confirmation before any provider write happens.

## Commands

Backend (Python / `uv`):

```bash
uv sync

uv run docket
uv run docket open --provider <provider>
uv run docket help
uv run docket status
uv run docket setup
uv run docket setup --step=<name>
uv run docket setup provider list
uv run docket setup provider add <name> --type <provider_type>
uv run docket setup provider remove <name>
uv run docket sync
uv run docket sync --full
uv run docket list --kind story
uv run docket show <id>
uv run docket transition <id> start_work --dry-run
uv run docket patch <id> --from-file TODO.md --dry-run
uv run docket new task --title "Title"
uv run docket project list
uv run docket memory list
uv run docket source list
uv run docket mcp list
uv run docket serve

uv run pytest
uv run pytest tests/integration/test_api.py
uv run pytest tests/unit/test_import_boundary.py
uv run pytest tests/pilot/test_tui_pilot.py
uv run pytest -k "pattern"

uv run ruff check .
uv run ruff format .
uv run mypy src
```

Frontend (React / `bun` in `frontend/`):

```bash
cd frontend && bun install
cd frontend && bun run dev         # vite dev server on :3000
cd frontend && bun run build
cd frontend && bun run typecheck   # tsc --noEmit
cd frontend && bun run lint        # biome check
cd frontend && bun run gen:api     # regenerate OpenAPI types from running backend
```

Cross-tree shortcuts (`Makefile`):

```bash
make install      # uv sync + bun install
make dev          # run backend (docket serve) and frontend (vite) together
make check        # lint + typecheck + test across both trees
make gen-api      # regenerate frontend OpenAPI types against the running backend
```

## Non-Negotiable Rules

- Keep concrete provider imports out of `src/docket/core/`, `src/docket/storage/`, `src/docket/agent/`, and `src/docket/api/`; those layers talk to `WorkItemProvider`, provider specs, or the registry, not `AzureDevOpsProvider`/`GitHubProvider` directly (`tests/unit/test_import_boundary.py`, `src/docket/providers/base.py`, `src/docket/providers/registry.py`).
- Translate provider-native kinds and states at the boundary and keep the rest of the app on canonical enums like `ItemKind`, `ItemState`, and `TransitionIntent` (`src/docket/core/model.py`, `src/docket/providers/azure_devops/state_map.py`, `src/docket/providers/github/state_map.py`, `src/docket/providers/github_stub/state_map.py`).
- Do not call `provider.transition`, `provider.patch_description`, `provider.upload_attachment`, or `provider.create_item` from CLI/TUI/API surfaces. In `src/`, provider writes go through `src/docket/core/services/mutation_service.py` only.
- Treat every provider or agent-side write as proposal-first: build a `Proposal`, render a diff, get confirmation, then confirm through `mutation_service.confirm(...)` (`src/docket/core/mutation.py`, `src/docket/core/services/mutation_service.py`, `src/docket/core/services/proposal_store.py`).
- Agent mutating tools only stage proposals. That includes work-item tools and project-memory tools; they do not write directly to providers or SQLite (`src/docket/agent/mutating_tools.py`, `src/docket/agent/memory_tools.py`).
- Project sources are different: the agent can read them, but source writes are human-driven only through CLI/TUI/API paths that go directly to the repo (`src/docket/storage/repos/source_repo.py`, `src/docket/cli/commands/source.py`, `src/docket/api/routes/source.py`, `src/docket/cli/tui/widgets/source_pane.py`, `src/docket/agent/source_tools.py`).
- Keep the prompt prefix byte-stable. Do not inject timestamps, usernames, scope labels, or other runtime-only text into the system-plus-snapshot prefix or prompt-cache hits will collapse (`src/docket/agent/prompt.py`, `src/docket/agent/tools.py`, `src/docket/agent/factory.py`, `tests/integration/test_prompt_loader.py`).
- Preserve agent tool registration order when touching tool wiring. Tool schema order is part of the cached prompt prefix (`src/docket/agent/tools.py`, `src/docket/agent/factory.py`, `src/docket/agent/source_tools.py`, `src/docket/agent/memory_tools.py`).
- Treat SQLite as a cache for provider-backed work items, not the system of record. Sync from the provider, and refresh cached rows after confirmed writes (`src/docket/core/services/sync_service.py`, `src/docket/core/services/mutation_service.py`).
- Pass `conn`, `provider`, `paths`, `config`, `provider_key`, `project_id`, and runtime state explicitly through contexts or `app.state`; do not introduce hidden global runtime singletons (`src/docket/cli/context.py`, `src/docket/api/app.py`, `src/docket/api/runtime.py`, `src/docket/api/agent_rebuild.py`).
- Read-only mode must block every mutation entry point and strip mutating agent tools and MCP tools, not just show a warning (`src/docket/cli/guard.py`, `src/docket/api/deps.py`, `src/docket/agent/factory.py`, `src/docket/cli/tui/app.py`, `tests/integration/test_cli_read_only.py`, `tests/integration/test_api_read_only.py`, `tests/pilot/test_read_only_mode.py`, `tests/integration/test_mcp.py`).
- Keep watchlist rows independent from `items(id)`; pinned ids are allowed to outlive the current cache scope (`src/docket/storage/schema.py`, `tests/integration/test_watchlist_repo.py`).
- Provider/project switches must rebuild the agent so tool closures rebind to the new `(provider, provider_key, project_id)` tuple (`src/docket/api/agent_rebuild.py`, `src/docket/cli/tui/app.py`).

## Testing

- Test layout is split by intent: `tests/unit/` for pure-Python units and architectural guards, `tests/integration/` for DB/FastAPI/Typer/service coverage, and `tests/pilot/` for Textual pilot flows.
- The test stack is `pytest`, `pytest-asyncio` in auto mode, `pytest-recording` for Azure DevOps coverage, and Textual pilot tests for the TUI (`pyproject.toml`, `tests/pilot/test_tui_pilot.py`).
- Favor fakes and pilot-style tests over private widget or CSS assertions (`tests/fakes/provider.py`, `tests/fakes/llm.py`, `tests/pilot/test_tui_chat_pilot.py`, `tests/integration/test_api.py`).
- Cross-cutting guardrails matter here: `tests/unit/test_import_boundary.py`, `tests/unit/test_state_map_reverse.py`, and `tests/integration/test_github_stub_provider.py` are architecture tests, not optional extras.
- If you change agent tooling, prompt loading, or runtime rebinding, cover both the pure service behavior and at least one surface-level path where practical.

## Testing-Specific Configuration

- Use the `tmp_xdg` fixture when a test touches config, prompts, logs, or the SQLite cache under XDG paths (`tests/conftest.py`).
- Prompt-loader tests reset module-level loader state before and after each case so prompt overrides do not leak across the suite (`tests/integration/test_prompt_loader.py`).
- Bootstrap setup tests stub the self-restart hook so `/setup/complete` can be exercised without killing the test process (`tests/integration/test_api_setup.py`).
- TUI tests should mount `DocketApp` with a fake provider via `run_test()` and drive behavior with pilot input rather than calling widget internals directly (`tests/pilot/test_tui_pilot.py`, `tests/pilot/test_diff_modal_pilot.py`).

## Architecture Guardrails

Current flow:

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

- `core/`, `storage/`, `agent/`, and `api/` to concrete provider modules.
- Surface adapters directly to provider write methods.
- Dynamic prompt-prefix fields before the cache boundary.
- Agent-side source mutation paths.

Future target:

- Keep `cli/`, `cli/tui/`, and `api/routes/` as thin adapters that parse input, call one service, and map the result back to UI or HTTP.
- Keep provider onboarding and plugin discovery centralized in registry/setup services rather than scattering provider-specific logic across surfaces.
- Move runtime rebind logic, config writes, and project-scoped admin actions toward shared services so TUI and HTTP cannot drift.
- Treat `config/` as file/path primitives plus schemas and setup orchestration, not as the long-term home for unrelated business logic.

## Global Invariants

- Prompt hot reload is mtime-keyed; edits apply on the next turn without restart (`src/docket/agent/prompt.py`, `src/docket/config/prompt_templates.py`).
- Conversation compaction summarizes older messages into a synthetic `system` row and marks originals as `compacted=1` so transcripts stay complete while live prompt history stays short (`src/docket/core/services/compaction_service.py`, `src/docket/storage/repos/message_repo.py`).
- External item changes are injected back into active conversations as system messages so the assistant does not keep reasoning over stale ticket state (`src/docket/core/services/external_update_service.py`).
- Source documents are intentionally excluded from the always-on prompt prefix; the agent reads them on demand through tools, so source edits do not invalidate the prompt cache (`src/docket/core/services/source_service.py`, `src/docket/storage/repos/source_repo.py`).
- MCP server config is per-project and persisted in `config.toml`; changing config does not automatically mutate a live manager unless the surface explicitly rebinds it (`src/docket/core/services/mcp_service.py`, `src/docket/agent/mcp/manager.py`, `src/docket/api/routes/mcp.py`).
- Bootstrap HTTP mode is a separate minimal app exposing only `/health` and `/setup/*` until `config.toml` exists (`src/docket/api/bootstrap_app.py`, `src/docket/api/routes/setup.py`).
- Telemetry is on by default and writes one JSON object per line to `<paths.log_dir>/docket.log` (rotating 1 MB x 3) at `DEBUG` level. The on-disk log is the only place some worker-thread tracebacks surface during a TUI session, so verbosity is intentional (`src/docket/telemetry/logging.py`, `src/docket/cli/context.py`, `src/docket/config/models.py`).

## Mutation Surface Pattern

```python
proposal = mutation_service.propose_transition(
    ctx.conn,
    item_id,
    intent,
    provider_key=ctx.active_provider,
)
result = apply_mutation(
    ctx.conn,
    ctx.provider,
    proposal,
    confirm_title=f"Transition {item_id} ({intent.value})",
    dry_run=dry_run,
    provider_key=ctx.active_provider,
)
```

The same shape applies across CLI, TUI, API, and agent-confirmed flows: stage a proposal first, then execute it only through `mutation_service.confirm(...)` (`src/docket/cli/confirm.py`, `src/docket/cli/commands/transition.py`, `src/docket/api/routes/mutations.py`, `src/docket/agent/mutating_tools.py`).

## Linting and Code Style

- Target Python is 3.12 (`pyproject.toml`).
- Ruff is the formatter and linter. Selected rule groups are `E`, `F`, `I`, `N`, `UP`, `B`, `SIM`, and `RUF`; line length is 100 and `E501` is ignored (`pyproject.toml`).
- Ruff applies per-file ignores to the `tests` tree and to the API and CLI command packages because those areas intentionally use testing shortcuts or FastAPI/Typer default expressions (`pyproject.toml`).
- Mypy runs in strict mode with the Pydantic plugin enabled; new code should carry real types, not placeholder annotations (`pyproject.toml`).
