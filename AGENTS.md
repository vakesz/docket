# Docket

## Project Snapshot

- Docket is a Python 3.12+ terminal-first work-item triage application with a Typer CLI, a Textual TUI, and an optional FastAPI HTTP surface.
- The codebase is organized as a layered, ports-and-adapters style package: surfaces in `cli/` and `api/`, canonical domain types in `core/`, workflow orchestration in `core/services/` and `agent/`, and adapters in `providers/`, `storage/`, `config/`, and `telemetry/`.
- The primary goal is safe local-first triage: cache items in SQLite for fast browsing, chat against a stable ticket snapshot, and require a visible confirmation step before any write reaches a provider.

## Commands

```bash
uv sync

uv run docket
uv run docket help
uv run docket setup
uv run docket setup --step=<name>
uv run docket setup provider list
uv run docket setup provider add <name> --type <provider_type>
uv run docket setup provider remove <name>
uv run docket sync
uv run docket sync --full
uv run docket list --kind story
uv run docket show <id>
uv run docket transition <id> <intent> --dry-run
uv run docket patch <id> --from-file TODO.md --dry-run
uv run docket new task --title "Title"
uv run docket serve

uv run pytest
uv run pytest tests/test_api.py
uv run pytest tests/test_api.py::test_list_items
uv run pytest -k "pattern"

uv run ruff check .
uv run ruff format .
uv run mypy src

# No dedicated clean command is checked in.
```

## Non-Negotiable Rules

- Keep concrete provider imports out of `src/docket/core/`, `src/docket/storage/`, `src/docket/agent/`, and `src/docket/api/`; those layers talk to `WorkItemProvider`, not Azure DevOps or GitHub classes (`tests/test_import_boundary.py`, `src/docket/providers/base.py`).
- Translate provider-native state at the boundary and keep the rest of the app on canonical enums like `ItemKind`, `ItemState`, and `TransitionIntent` (`src/docket/core/model.py`, `src/docket/providers/azure_devops/state_map.py`, `src/docket/providers/github/state_map.py`).
- Do not call `provider.transition`, `provider.patch_description`, `provider.upload_attachment`, or `provider.create_item` from surfaces; in `src/` those writes go through `src/docket/core/services/mutation_service.py` only (verified by search, plus `src/docket/cli/commands/transition.py` and `src/docket/api/routes/mutations.py`).
- Treat every write as proposal-first: build a `Proposal`, render a diff, get confirmation, then confirm through `mutation_service.confirm(...)` (`src/docket/core/mutation.py`, `src/docket/core/services/mutation_service.py`).
- Agent mutating tools only stage proposals; they never write directly to a provider (`src/docket/agent/mutating_tools.py`).
- Keep the prompt prefix byte-stable; do not inject timestamps, scope labels, or usernames into the system-plus-snapshot prefix or prompt cache hits will collapse (`src/docket/agent/prompt.py`, `tests/test_prompt_loader.py`).
- Preserve tool registration order when touching agent tooling; tool schema order is part of the cached prompt prefix (`src/docket/agent/tools.py`).
- Treat SQLite as a cache, not the system of record; refresh from the provider and refresh local rows after writes (`src/docket/core/services/sync_service.py`, `src/docket/core/services/mutation_service.py`).
- Pass `conn`, `provider`, `paths`, `config`, and runtime state explicitly through contexts or `app.state`; do not introduce hidden global runtime singletons (`src/docket/cli/context.py`, `src/docket/api/app.py`, `src/docket/cli/tui/app.py`).
- Read-only mode must block every mutation entry point and strip mutating agent tools, not just show a warning (`src/docket/cli/guard.py`, `src/docket/api/deps.py`, `src/docket/cli/tui/app.py`, `tests/test_cli_read_only.py`, `tests/test_api_read_only.py`, `tests/test_read_only_mode.py`).
- Keep watchlist rows independent from `items(id)`; pinned ids are allowed to outlive the current cache scope (`src/docket/storage/schema/v6.py`).

## Testing

- Test stack: `pytest`, `pytest-asyncio` in auto mode, `pytest-recording` for Azure DevOps cassettes, and Textual pilot tests for the TUI (`pyproject.toml`, `tests/test_tui_pilot.py`).
- Tests live in a dedicated `tests/` tree, with in-memory doubles under `tests/fakes/` and higher-level API, TUI, provider, migration, and service coverage beside them.
- Favor fakes and pilot-style tests over private widget or CSS assertions (`tests/test_tui_pilot.py`, `tests/test_api.py`, `tests/fakes/provider.py`, `tests/fakes/llm.py`).
- Cross-cutting guardrails matter here: `tests/test_import_boundary.py`, `tests/test_state_map_reverse.py`, and `tests/test_github_stub_provider.py` are architectural tests, not optional extras.

## Testing-Specific Configuration

- Use the `tmp_xdg` fixture when a test touches config, prompts, logs, or the SQLite cache under XDG paths (`tests/conftest.py`).
- Prompt-loader tests reset the module-level loader before and after each case so prompt overrides do not leak across the suite (`tests/test_prompt_loader.py`).
- Bootstrap setup tests stub the self-restart hook so `/setup/complete` can be exercised without killing the test process (`tests/test_api_setup.py`).

## Architecture Guardrails

Current flow:

```text
docket / docket serve
        |
        v
cli.app / cli.commands.serve
        |
        v
cli.context.prepare[_or_wizard]
  resolve paths -> load env -> load config -> init SQLite -> build providers
        |
        +--> Textual TUI (DocketApp)
        |      reads SQLite cache
        |      syncs via sync_service
        |      chats via conversation_service -> AgentLoop
        |      mutates via mutation_service -> confirm modal
        |
        +--> FastAPI app
               routes -> deps/runtime -> services
               SSE chat -> conversation_service
               mutations -> proposal endpoints -> mutation_service.confirm
```

Forbidden edges:

- `core/`, `storage/`, `agent/`, and `api/` to concrete provider modules.
- Surface adapters directly to provider write methods.
- Dynamic prompt-prefix fields before the cache boundary.

Future target:

- Keep `cli/`, `cli/tui/`, and `api/routes/` as thin adapters that parse input, call one service, and map the result back to UI or HTTP.
- Move setup, prompt-file edits, config writes, runtime switching, and agent-runtime assembly toward shared services instead of duplicating them in widgets and route modules.
- Treat `config/` as file/path primitives plus schemas, not as the long-term home for provider-specific onboarding logic.
- See [.docs/architecture.md](.docs/architecture.md) and [.docs/exception-audit.md](.docs/exception-audit.md) before extending an existing hotspot.

## Global Invariants

- Prompt hot reload is mtime-keyed; edits apply on the next turn without restart (`src/docket/agent/prompt.py`, `src/docket/config/prompt_templates.py`).
- Conversation compaction summarizes older messages into a synthetic `system` row and marks originals as `compacted=1` so transcripts stay complete while live prompt history stays short (`src/docket/core/services/compaction_service.py`, `src/docket/storage/repos/message_repo.py`).
- External item changes are injected back into active conversations as system messages so the assistant does not keep reasoning over stale ticket state (`src/docket/core/services/external_update_service.py`).
- Bootstrap HTTP mode is a separate minimal app exposing only `/health` and `/setup/*` until `config.toml` exists (`src/docket/api/bootstrap_app.py`, `src/docket/api/routes/setup.py`).

## Mutation Surface Pattern

```python
proposal = mutation_service.propose_transition(ctx.conn, item_id, intent)
if not prompt_confirm(proposal, title=f"Transition {item_id} ({intent.value})"):
    raise typer.Exit(1)
result = mutation_service.confirm(ctx.conn, ctx.provider, proposal)
```

Derived from `src/docket/cli/commands/transition.py`, with the same shape repeated in `src/docket/cli/commands/new.py`, `src/docket/cli/commands/patch.py`, `src/docket/api/routes/mutations.py`, and `src/docket/agent/mutating_tools.py`.

## Linting and Code Style

- Target Python is 3.12 (`pyproject.toml`).
- Ruff is the formatter and linter. Selected rule groups are `E`, `F`, `I`, `N`, `UP`, `B`, `SIM`, and `RUF`; line length is 100 and `E501` is ignored (`pyproject.toml`).
- Ruff applies per-file ignores to the `tests` tree and to the API and CLI command packages because those areas intentionally use testing shortcuts or FastAPI/Typer default expressions (`pyproject.toml`).
- Mypy runs in strict mode with the Pydantic plugin enabled; generated code needs real types, not “good enough” annotations (`pyproject.toml`).

## Docs Index

- [.docs/agent-workloads.md](.docs/agent-workloads.md)
- [.docs/repo-map.md](.docs/repo-map.md)
- [.docs/architecture.md](.docs/architecture.md)
- [.docs/modules.md](.docs/modules.md)
- [.docs/workflows.md](.docs/workflows.md)
- [.docs/exception-audit.md](.docs/exception-audit.md)
- [.docs/playbooks/mutation-pipeline.md](.docs/playbooks/mutation-pipeline.md)
- [.docs/playbooks/agent-chat.md](.docs/playbooks/agent-chat.md)
- [.docs/playbooks/provider-layer.md](.docs/playbooks/provider-layer.md)
- [.docs/playbooks/http-surfaces.md](.docs/playbooks/http-surfaces.md)
- [.docs/playbooks/tui-surface.md](.docs/playbooks/tui-surface.md)
- [.docs/playbooks/config-and-setup.md](.docs/playbooks/config-and-setup.md)
- [.docs/playbooks/storage-cache.md](.docs/playbooks/storage-cache.md)
