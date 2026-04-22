# Agent Workloads

## Start Here

- Read [CLAUDE.md](../CLAUDE.md) first for repo-wide invariants and commands.
- Use [Architecture](architecture.md) for current flow and the future target shape.
- Use [Exception Audit](exception-audit.md) before extending setup, config, prompt, or TUI orchestration code.

## Task Routing

- Change anything that writes to providers, proposal UX, or confirm flows -> [Mutation Pipeline](playbooks/mutation-pipeline.md)
- Change prompt building, chat behavior, tool registration, compaction, transcript upload, or external-update injection -> [Agent Chat](playbooks/agent-chat.md)
- Add or modify a provider, state map, registry entry, or provider-specific capability -> [Provider Layer](playbooks/provider-layer.md)
- Change FastAPI routes, auth, SSE streaming, bootstrap setup mode, provider/scope switching, or API runtime state -> [HTTP Surfaces](playbooks/http-surfaces.md)
- Change Textual panes, widgets, commands, modal flows, or background timers -> [TUI Surface](playbooks/tui-surface.md)
- Change XDG paths, `.env` precedence, config persistence, prompt files, or setup flows -> [Config and Setup](playbooks/config-and-setup.md)
- Change SQLite schema, repos, FTS behavior, sync watermarks, or watchlist persistence -> [Storage Cache](playbooks/storage-cache.md)
- Decide where new code belongs or whether a hotspot should be split up -> [Repo Map](repo-map.md), [Modules](modules.md), and [Architecture](architecture.md)

## Fast Reminders

- Keep provider-specific imports out of `core/`, `storage/`, `agent/`, and `api/`.
- Route provider writes through `mutation_service`; do not bypass the proposal gate.
- Keep prompt-prefix bytes stable and tool order deterministic.
- Treat SQLite as cache-only and refresh cache rows after provider writes.
- Read-only mode must remove mutating agent tools and block every mutation surface.
- Use `TuiContext` or `app.state` injection instead of introducing globals.
- Prefer fakes and pilot tests to brittle UI internals.
- Preserve watchlist semantics: no FK from pinned ids to current cache contents.
- Use the provider registry for provider creation; do not spread new factories across adapters.
- Before adding code to `cli/tui/app.py` or `config/setup_wizard.py`, check the exception audit and prefer a new service or helper.

## Verification Shortcuts

- Mutation flow changes: `uv run pytest tests/test_mutation_service.py tests/test_api.py tests/test_api_read_only.py tests/test_mutating_tools.py`
- Agent or prompt changes: `uv run pytest tests/test_prompt_loader.py tests/test_conversation_service.py tests/test_compaction.py tests/test_external_update_service.py tests/test_attach_transcript.py`
- Provider changes: `uv run pytest tests/test_github_stub_provider.py tests/test_state_map_reverse.py tests/test_import_boundary.py`
- TUI changes: `uv run pytest tests/test_tui_pilot.py tests/test_read_only_mode.py tests/test_diff_modal_pilot.py tests/test_batch_review_pilot.py`
- Setup or config changes: `uv run pytest tests/test_setup_wizard.py tests/test_api_setup.py tests/test_config.py`
- Storage or sync changes: `uv run pytest tests/test_repos.py tests/test_search_repo.py tests/test_migrations.py tests/test_sync_service.py tests/test_watchlist_repo.py`
- Full safety pass: `uv run ruff check . && uv run mypy src && uv run pytest`
