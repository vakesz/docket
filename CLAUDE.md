# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
uv sync                              # create venv, install runtime + dev deps
uv run docket                        # launch the TUI (falls through to setup wizard on first run)
uv run docket setup                  # re-run the first-time setup wizard (resumable: --step=<name>)
uv run docket setup provider add <name>      # register an additional provider on top of an existing config
uv run pytest                        # full test suite (asyncio_mode=auto)
uv run pytest tests/test_foo.py      # one file
uv run pytest tests/test_foo.py::test_bar   # one test
uv run pytest -k "pattern"           # by name match
uv run ruff check .                  # lint (line-length 100, selects E/F/I/N/UP/B/SIM/RUF)
uv run ruff format .                 # autoformat
uv run mypy src                      # strict type-check (pydantic plugin enabled)
```

The entrypoint is `docket.cli.app:main` → Typer app. `docket` with no subcommand runs the TUI; the setup wizard auto-triggers when `config.toml` is missing. Hidden CLI aliases exist (`ls`, `view`, `browse`, `ui`, `refresh`, `create`) and are enumerated in `cli/commands/help_cmd.py`.

## Architecture

Phase-2 milestones M1–M16 are landed; comment draft queue is the only M16 carve-out still tracked as follow-up. `README.md` has the user-facing tour and the "Adding a provider" contract; `docs/FIRST_TIME_SETUP.md` covers installation paths. The invariants below are enforced by tests — violating one should fail a test, not silently drift.

**Layered dependency rule (enforced by `tests/test_import_boundary.py`):** `core/`, `storage/`, `agent/`, and `api/` must not import from `docket.providers.azure_devops` directly — that is the literal string the test scans for, but the *intent* covers any concrete provider package (`github`, `github_stub`, future Jira/Linear). They speak only to `providers.base.WorkItemProvider`. `cli/` is the single allowed exception because it wires concrete providers by name through `providers/registry.py`. Breaking this test means provider-specific state strings, field names, or HTML handling have leaked into neutral code — fix the leak, not the test.

**Provider interface (`providers/base.py`):** one Protocol covering `health_check`, `list_changes_since`, `get_item`, `get_comments`, `get_linked`, `transition(id, TransitionIntent)`, `patch_description`, `upload_attachment`, `create_item`. State strings and HTML quirks live in the provider (`providers/<name>/state_map.py`, field maps). The canonical model (`core/model.py`) uses stable enums (`ItemKind`, `ItemState`, `TransitionIntent`) — never raw provider strings. Providers in tree: `azure_devops` (production), `github` (issues + PRs), `github_stub` (in-memory reference impl used by demos and the cross-cutting test suite). `providers/registry.py` exposes `register`/`build`/`types` and loads third-party providers from the `docket.providers` entry-point group on first call.

**Optional capabilities are gated by method presence**, not declarations. The agent's `find_related_prs` tool is registered only when `getattr(provider, "find_related_prs", None)` is truthy. Follow this pattern for any provider-specific tool — don't add Protocol methods for capabilities most providers won't have.

**Service layer (`core/services/`) is the single write path.** Every mutation — CLI, TUI, HTTP, and agent tool-call — funnels through `mutation_service.propose` → `render_diff` → `confirm`. The TUI opens a diff modal; the HTTP API returns a `Proposal` that a second request confirms; agent `propose_*` tools (in `agent/mutating_tools.py`) do not write directly. Batch review in the TUI snapshots the queue so new proposals landing mid-review stay queued. `ProposalStore` (`core/services/proposal_store.py`) holds pending proposals for the TUI. Other services worth knowing: `sync_service` (watermark refresh), `conversation_service` (chat threads + message persistence), `compaction_service` (transcript trimming for prompt-cache safety), `external_update_service` (background watch for ticket changes), `suggestion_service` (structured next-action proposals).

**HTTP API (`api/`)** is a FastAPI app mounted by `docket serve`. Routes live in `api/routes/{items,conversations,mutations}.py`; SSE is via `sse-starlette`. The mutations route returns a `Proposal` on POST and writes only on a follow-up confirm — same gate as TUI/agent. `api/auth.py` and `api/deps.py` hold the request dependencies; read-only mode short-circuits the mutations router entirely.

**Prompt layout is cache-stable (`agent/prompt.py`).** The prefix `[system + kind template] → [ticket snapshot] → ---` must stay byte-identical across turns or Foundry prompt caching misses. Do not interpolate timestamps, usernames, or scope into the prefix — only the item's own fields, which legitimately invalidate the cache when the ticket changes. Prompt files live at `$XDG_CONFIG_HOME/docket/prompts/` with canonical names `system_base.md` and `kind_<kind>.md`; the loader keeps an mtime-keyed cache so edits hot-reload on the next turn without restart. Legacy filename `<kind>.md` (old wizard) still loads as a fallback. The Foundry client (`agent/foundry_client.py`) and tool loop (`agent/loop.py`) feed this prefix into Azure OpenAI; transcripts (`agent/transcript.py`) are persisted to SQLite and uploaded as a ticket attachment on close, with secrets scrubbed by `core/redaction.py` (regex-based; extend the patterns there, not at the call site).

**SQLite is the cache, not the source of truth.** `sync_service.refresh` pulls changes since a watermark per scope; `items`, `comments`, `conversations`, `messages`, `attachments`, `watchlist`, `sync_state` tables. Migrations keyed by `PRAGMA user_version` in `storage/schema/`; FTS5 virtual table backs the TUI filter. `conn: sqlite3.Connection` is threaded through services explicitly — no global singleton. Repos in `storage/repos/` use `executemany` for bulk upserts; provider implementations should call `upsert_items` (plural) rather than looping `upsert_item`.

**TUI (`cli/tui/`)** is a Textual app with three panes (`ItemTree` / `ItemDetail` / `ChatPane`) plus a custom `StatusBar` and modal screens (`DiffModal`, `BatchDiffModal`, `SettingsModal`, `PromptLibraryModal`, `HelpModal`, `QuickOpenModal`, `ThemePicker`, `NewItemModal`, `SuggestionModal`). `TuiContext` is the injection seam — the TUI accepts a lightweight bundle of `conn`, `provider`, `scope`, optional `llm`, and feature toggles so pilot tests can mount the app against fakes. Background timers (`set_interval` for external-update watch and background sync) spawn threaded workers so provider I/O never blocks the event loop. Read-only mode (`--read-only` flag or `DOCKET_READ_ONLY=1`) propagates through `TuiContext`; mutating agent tools are simply not registered, CLI mutation commands refuse early, and the API mutations router 403s.

**Config and paths.** `Paths` (`config/paths.py`) resolves XDG locations via `platformdirs`. `Config` is a Pydantic model in `config/models.py` written atomically via `config/loader.save_config`. `.env` is read from the repo root and `$XDG_CONFIG_HOME/docket/.env` and wins over `config.toml` for the LLM endpoint/keys. Prompt templates are defined once in `config/prompt_templates.py` (`PROMPT_TEMPLATES` registry) and used by both the loader and the in-app editor — keep them in sync. Acceptance-criteria extraction (`core/acceptance.py`) parses Markdown checklists from descriptions for the TUI sidebar — not provider-specific.

## Testing conventions

- `pytest-asyncio` in auto mode. TUI tests are "pilot" style: mount `ItvApp` with a fake provider via `app.run_test()` and drive with `pilot.press(...)`. Prefer this over asserting on CSS or private widget state.
- `tests/fakes/` holds `FakeProvider`, scripted LLM replies, etc. `tests/fixtures/cassettes/` holds VCR cassettes for `AzureDevOpsProvider` tests (pytest-recording).
- `conftest.py` provides `tmp_xdg` which monkeypatches `XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME` to a temp root — use it whenever a test touches real config paths.
- Three cross-cutting invariant tests: `test_import_boundary.py` (no concrete-provider leaks), `test_state_map_reverse.py` (every `TransitionIntent` round-trips through every provider's state map), `test_github_stub_provider.py` (the reference suite every new provider should also pass). If one fails, fix the underlying drift, not the test.

## Conventions worth respecting

- **Markdown is the canonical description format.** Providers convert to HTML only when the backend can't accept Markdown (ADO HTML-only projects set a flag in `sync_state`).
- **Named intents, not state strings.** CLI/TUI/HTTP/agent all pass `TransitionIntent` values; the mapping to provider-specific states happens inside the provider. Adding a new transition means extending the enum and every provider's state map (the round-trip test will tell you if you missed one).
- **Offline is fail-fast in phase 1.** No queued mutations — if the provider is unreachable, surface it. The background sync tick flips a status-bar offline flag on exception but does not retry silently.
- **Confirm-before-mutate, always.** Including agent-proposed writes. Never shortcut the diff modal — there is no "it's just a CLI flag" exception.
