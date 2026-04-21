# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
uv sync                              # create venv, install runtime + dev deps
uv run docket                        # launch the TUI (falls through to setup wizard on first run)
uv run docket setup                  # re-run the first-time setup wizard
uv run pytest                        # full test suite (asyncio_mode=auto)
uv run pytest tests/test_foo.py      # one file
uv run pytest tests/test_foo.py::test_bar   # one test
uv run pytest -k "pattern"           # by name match
uv run ruff check .                  # lint (line-length 100, selects E/F/I/N/UP/B/SIM/RUF)
uv run ruff format .                 # autoformat
uv run mypy src                      # strict type-check (pydantic plugin enabled)
```

The entrypoint is `docket.cli.app:main` → Typer app. `docket` with no subcommand runs the TUI; setup wizard auto-triggers when `config.toml` is missing. Hidden CLI aliases exist (`ls`, `view`, `browse`, `ui`, `refresh`, `create`) and are enumerated in `cli/commands/help_cmd.py`.

## Architecture

`plan.md` is the source of truth for architecture and milestones — consult it before making structural changes. Phase-2 milestones M9–M16 are locked; M1–M8 are landed.

**Layered dependency rule (enforced by `tests/test_import_boundary.py`):** `core/`, `storage/`, `agent/`, and `api/` must not import from `providers/azure_devops/` (or any concrete provider) directly. They speak only to `providers.base.WorkItemProvider`. `cli/` is the single allowed exception because it wires concrete providers by name. Breaking this test means provider-specific state strings, field names, or HTML handling have leaked into neutral code.

**Provider interface (`providers/base.py`):** one Protocol covering `list_changes_since`, `get_item`, `get_comments`, `get_linked`, `transition(id, TransitionIntent)`, `patch_description`, `upload_attachment`, `create_item`. State strings and HTML quirks live in the provider (`providers/azure_devops/state_map.py`, field maps). The canonical model (`core/model.py`) uses stable enums (`ItemKind`, `ItemState`, `TransitionIntent`) — never raw provider strings.

**Service layer (`core/services/`) is the single write path.** Every mutation — CLI, TUI, HTTP, and agent tool-call — funnels through `mutation_service.propose` → `render_diff` → `confirm`. The TUI opens a diff modal; the HTTP API returns a `Proposal` that a second request confirms; agent `propose_*` tools do not write directly. Batch review in the TUI snapshots the queue so new proposals landing mid-review stay queued. `ProposalStore` (in `core/services/proposal_store.py`) holds pending proposals for the TUI.

**Prompt layout is cache-stable (`agent/prompt.py`).** The prefix `[system + kind template] → [ticket snapshot] → ---` must stay byte-identical across turns or Foundry prompt caching misses. Do not interpolate timestamps, usernames, or scope into the prefix — only the item's own fields, which legitimately invalidate the cache when the ticket changes. Prompt files live at `$XDG_CONFIG_HOME/docket/prompts/` with canonical names `system_base.md` and `kind_<kind>.md`; the loader keeps an mtime-keyed cache so edits hot-reload on the next turn without restart. Legacy filename `<kind>.md` (old wizard) still loads as a fallback.

**SQLite is the cache, not the source of truth.** `sync_service.refresh` pulls changes since a watermark per scope; `items`, `comments`, `conversations`, `messages`, `attachments`, `sync_state` tables. Migrations keyed by `PRAGMA user_version` in `storage/schema/`; FTS5 virtual table backs the TUI filter. `conn: sqlite3.Connection` is threaded through services explicitly — no global singleton.

**TUI (`cli/tui/`)** is a Textual app with three panes (`ItemTree` / `ItemDetail` / `ChatPane`) plus a custom `StatusBar` and modal screens (`DiffModal`, `BatchDiffModal`, `SettingsModal`, `PromptLibraryModal`, `HelpModal`, `QuickOpenModal`, `ThemePicker`, `NewItemModal`, `SuggestionModal`). `TuiContext` is the injection seam — the TUI accepts a lightweight bundle of `conn`, `provider`, `scope`, optional `llm`, and feature toggles so pilot tests can mount the app against fakes. Background timers (`set_interval` for external-update watch and background sync) spawn threaded workers so provider I/O never blocks the event loop. Agent writes are gated behind `read_only` — mutating tools are simply not registered in read-only mode.

**Config and paths.** `Paths` (`config/paths.py`) resolves XDG locations via `platformdirs`. `Config` is a Pydantic model in `config/models.py` written atomically via `config/loader.save_config`. `.env` is read from the repo root and `$XDG_CONFIG_HOME/docket/.env` and wins over `config.toml` for the LLM endpoint/keys. Prompt templates are defined once in `config/prompt_templates.py` (`PROMPT_TEMPLATES` registry) and used by both the loader and the in-app editor — keep them in sync.

## Testing conventions

- `pytest-asyncio` in auto mode. TUI tests are "pilot" style: mount `ItvApp` with a fake provider via `app.run_test()` and drive with `pilot.press(...)`. Prefer this over asserting on CSS or private widget state.
- `tests/fakes/` holds `FakeProvider`, scripted LLM replies, etc. `tests/fixtures/cassettes/` holds VCR cassettes for `AzureDevOpsProvider` tests (pytest-recording).
- `conftest.py` provides `tmp_xdg` which monkeypatches `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` to a temp root — use it whenever a test touches real config paths.
- `test_import_boundary.py` guards the provider-abstraction invariant. If it fails, fix the import leak rather than the test.

## Conventions worth respecting

- **Markdown is the canonical description format.** Providers convert to HTML only when the backend can't accept Markdown (ADO HTML-only projects set a flag in `sync_state`).
- **Named intents, not state strings.** CLI/TUI/HTTP/agent all pass `TransitionIntent` values; the mapping to provider-specific states happens inside the provider. Adding a new transition means extending the enum and every provider's state map.
- **Offline is fail-fast in phase 1.** No queued mutations — if the provider is unreachable, surface it. The background sync tick flips a status-bar offline flag on exception but does not retry silently.
- **Confirm-before-mutate, always.** Including agent-proposed writes. Never shortcut the diff modal.
