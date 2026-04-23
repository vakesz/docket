# Docket

> **Terminal-first work-item triage — fast local cache, three-pane TUI, and an AI assistant that asks before it writes.**

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![uv](https://img.shields.io/badge/packaging-uv-261230?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![Type-checked: mypy](https://img.shields.io/badge/type--checked-mypy%20strict-2a6db2?logo=python&logoColor=white)](https://mypy-lang.org/)
[![Lint: ruff](https://img.shields.io/badge/lint-ruff-261230?logo=ruff&logoColor=white)](https://docs.astral.sh/ruff/)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-ready-0078d7?logo=azuredevops&logoColor=white)](#providers)
[![GitHub](https://img.shields.io/badge/GitHub-ready-181717?logo=github&logoColor=white)](#providers)

Browse · Filter · Chat · Transition · Patch · Create — without leaving your terminal.

---

## Contents

- [Why Docket](#why-docket)
- [Feature tour](#feature-tour)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [TUI cheat sheet](#tui-cheat-sheet)
- [Web UI](#web-ui)
- [Providers](#providers)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Testing](#testing)
- [Development](#development)
- [License](#license)

---

## Why Docket

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the whole loop — the backlog, the selected item, and an LLM assistant — side-by-side in a Textual TUI you can run over SSH or in a tmux pane, and it keeps every write behind a visible confirm step.

- **Local-first.** SQLite cache with FTS5 full-text search means browsing and filtering are instant, even when the remote provider is slow or unreachable.
- **Multi-provider.** One `WorkItemProvider` protocol, one canonical model. Ships with Azure DevOps and GitHub live, plus a `github_stub` for tests and demos. Swap providers from the command palette.
- **Safe by design.** Every mutation — CLI, TUI, HTTP, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode hides write tools from the agent entirely.
- **Prompt-caching friendly.** The system/kind prefix is byte-stable across turns, so the Azure OpenAI prompt cache hits on every follow-up.

---

## Feature tour

### Browse and navigate

- Three resizable panes: backlog, detail, assistant
- Live filter (FTS5 over title, description, comments)
- Quick-open by id (`:`)
- Fullscreen any pane (`Ctrl+F`)
- Theme picker with live preview (`Ctrl+T`)
- Command palette for every action (`Ctrl+P`)
- Stale marker (`STALE — Xd`) after a configurable threshold

### Pin and focus

- Watchlist pins survive scope and view switches (`w`)
- Pinned section always at the top of the tree
- Join on live items — archived pins drop out silently

### Chat with safety rails

- Streaming assistant pane wired to the active ticket
- Prompt library — edit system + per-kind prompts from the app (`p`)
- Suggest next action (`s`) with structured output
- Acceptance-criteria checklist extracted from the description
- Transcript upload as a ticket attachment on close (with regex-based secret redaction)

### Mutate with a confirm gate

- Diff modal on every transition, description patch, new item
- Batch review when the agent proposes multiple writes in one turn
- Read-only mode via `--read-only` or `DOCKET_READ_ONLY=1`
- Background list sync with per-provider rate-limit floor

---

## Quick start

```bash
# 1. Install
git clone <repo-url> docket && cd docket
uv sync

# 2. Configure — walks you through provider, scope, LLM, prompts, first sync
uv run docket setup

# 3. Launch the TUI
uv run docket
```

First run with no config falls straight into the wizard, so step 2 is optional if you're happy typing answers at step 3.

---

## CLI reference

| Command | What it does |
| --- | --- |
| `docket` | Open the TUI (default when no subcommand is given) |
| `docket help` | Command list with quick examples |
| `docket status` | Show the active provider, scope, project, and cache state |
| `docket sync` / `sync --full` | Pull changes from the active provider |
| `docket list --kind story` | List cached items (filter by kind, state, assignee) |
| `docket show <id>` | Show one item's full detail |
| `docket new task --title "Follow up"` | Create a new item through the confirm gate |
| `docket transition <id> start_work --dry-run` | Preview a named transition; drop `--dry-run` to confirm |
| `docket patch <id> --from-file body.md --dry-run` | Preview a description update |
| `docket open --provider <key>` | Open the TUI against a specific provider |
| `docket serve` | Run the FastAPI HTTP surface (defaults to `127.0.0.1:8765`) |
| `docket setup` / `setup --step=<name>` | Run or resume the setup wizard |
| `docket setup provider add <name> --type <type>` | Register an additional provider |
| `docket project` / `memory` / `source` / `mcp` | Manage projects, project memory, sources, and MCP servers |

Bare `docket` always runs the TUI — subcommands still work, and a missing config auto-triggers the wizard.

---

## TUI cheat sheet

### Navigation

- `Tab` / `Shift+Tab` — next/previous pane
- `/` — focus the filter
- `:` — quick-open by id
- `Ctrl+F` — maximize/restore the focused pane
- `Ctrl+Left` / `Ctrl+Right` — resize the focused pane
- `Ctrl+P` — command palette

### Actions

- `r` — refresh (sync now)
- `n` — new item
- `t` — new chat thread
- `s` — suggest next action
- `o` — open item in browser
- `w` — pin/unpin the focused item
- `d` — review pending proposals
- `c` — show/hide done items

### Meta

- `?` / `F1` / `h` — in-app help
- `,` — settings editor
- `p` — prompt library
- `m` — memory editor
- `u` — sources editor
- `Shift+M` — MCP servers
- `Ctrl+T` — theme picker
- `q` — quit

---

## Web UI

Docket ships with a React web client in `frontend/` that consumes the FastAPI surface. It is optional — the TUI is the primary interface — but handy when you want a browser view of the same cache.

```bash
make install   # uv sync + bun install (one-time)
make dev       # run `docket serve` + vite dev server together
```

The backend is at `http://127.0.0.1:8765` and the frontend at `http://localhost:3000`. Regenerate the OpenAPI-typed client with `make gen-api` while the backend is running.

Stack: React 19, TanStack Router/Query, Vite, Tailwind, Biome, Bun.

---

## Providers

| Provider | Auth | Scope filters | Notes |
| --- | --- | --- | --- |
| **Azure DevOps** (`azure_devops`) | `az login` | team, area path, iteration path, assignee | Production path. Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |
| **GitHub** (`github`) | `gh auth token`, `GITHUB_TOKEN` fallback | assignee | Issues + PRs mapped to the canonical model. `find_related_prs` agent tool scans recent PRs for id/keyword mentions. |
| **github_stub** (`github_stub`) | — | any | In-memory reference impl for tests and demos. Useful when you want to poke at the TUI without wiring a real backend. |

Adding Jira, Linear, or a custom system is a matter of satisfying the `WorkItemProvider` Protocol in `src/docket/providers/base.py`: implement `fetch_list`, `fetch_detail`, `transition`, `patch_description`, `upload_attachment`, and `create_item`, plus a state-map module that translates provider-native states to canonical `ItemState` / `TransitionIntent`. Register it with `register_provider(...)` from `src/docket/providers/registry.py`, or ship it as a separate pip package that declares a `docket.providers` entry-point.

---

## Configuration

Docket stores everything under XDG paths resolved by `platformdirs`:

| Path (macOS) | Purpose |
| --- | --- |
| `~/Library/Application Support/docket/config.toml` | providers, scopes, LLM settings, UI preferences |
| `~/Library/Application Support/docket/.env` | optional local secrets (Azure OpenAI key, provider tokens) |
| `~/Library/Application Support/docket/prompts/` | `system_base.md` + `kind_<kind>.md` — live-reloads on save |
| `~/Library/Caches/docket/docket.db` | SQLite cache (items, comments, messages, watchlist, FTS5) |
| `~/Library/Logs/docket/` | structlog output |

Linux and Windows resolve to their usual XDG equivalents. The setup wizard writes `config.toml` atomically after every step; partial runs are resumable via `docket setup --step=<name>`.

### Environment variables worth knowing

| Variable | Effect |
| --- | --- |
| `DOCKET_READ_ONLY=1` | Disable every mutation path — agent tools, CLI writes, TUI confirm modals |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI client config; `.env` takes precedence over `config.toml` |
| `GITHUB_TOKEN` | Fallback for the GitHub provider when `gh auth token` isn't available |
| `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | Override docket paths (tests use this to sandbox per-test) |

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│ CLI (typer)    TUI (Textual)    API (FastAPI + SSE)          │
└─────────┬───────────┬──────────────────┬─────────────────────┘
          ▼           ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│                 core/services   ← single write gate          │
│      mutation_service · sync_service · conversation_service  │
└────────────┬──────────────────────────────────┬──────────────┘
             ▼                                  ▼
┌──────────────────────────┐        ┌────────────────────────┐
│    providers/base        │        │   storage (SQLite)     │
│ WorkItemProvider Protocol│        │  items · comments · fts│
└────────────┬─────────────┘        │  conversations · msgs  │
             ▼                      │  watchlist · attach.   │
  ┌──────────┼──────────┐           └────────────────────────┘
  ▼          ▼          ▼
Azure DevOps  GitHub   github_stub
```

Core rules that hold this together:

- `core/`, `storage/`, `agent/`, and `api/` **must not** import concrete providers — they speak only to the `WorkItemProvider` Protocol. Enforced by `tests/unit/test_import_boundary.py`.
- **Named transition intents** (`TransitionIntent.CLOSE_DONE`, `.START_WORK`, …) are the canonical mutation vocabulary. Providers translate them to native state strings inside `state_map.py`.
- **Every mutation** — from a keystroke, a CLI flag, an HTTP POST, or an LLM tool call — goes through `mutation_service.propose → render_diff → confirm`. There is no shortcut.
- **The prompt prefix is cache-stable**: `[system + kind template] → [ticket snapshot] → ---` is byte-identical across turns, so prompt caching hits on every follow-up.

These invariants are enforced by tests — `tests/unit/test_import_boundary.py`, `tests/unit/test_state_map_reverse.py`, and the per-provider cross-cutting suites in `tests/integration/test_github_stub_provider.py` — so a refactor that violates one fails loudly.

---

## Testing

```bash
uv run pytest                                           # full suite, async auto-mode
uv run pytest tests/integration/test_api.py             # one file
uv run pytest tests/integration/test_api.py::test_name  # one test
uv run pytest -k "pattern"                              # by name
uv run ruff check . && uv run ruff format .
uv run mypy src                                         # strict
```

Testing conventions:

- Tests live under three trees: `tests/unit/` (pure Python), `tests/integration/` (DB/FastAPI/Typer), `tests/pilot/` (Textual `run_test()`).
- **TUI tests are pilot-style** — mount `DocketApp` with a `FakeProvider` via `app.run_test()` and drive with `pilot.press(...)`. Don't assert on CSS or private widget state.
- **`tmp_xdg` fixture** in `conftest.py` sandboxes every XDG path into a temp root. Use it whenever a test touches config.
- **VCR cassettes** under `tests/fixtures/cassettes/` back the live `AzureDevOpsProvider` tests (pytest-recording).
- **`test_import_boundary.py`** guards the provider-abstraction invariant — if it fails, fix the import leak, not the test.

---

## Development

```bash
uv sync                        # installs runtime + dev extras
uv run docket                  # smoke-run the TUI
uv run ruff check . && uv run mypy src && uv run pytest
```

Repo layout:

```text
src/docket/
├── cli/         # typer entrypoint + commands + Textual TUI
├── api/         # FastAPI app (items / conversations / SSE stream)
├── core/        # canonical model + services (the single write gate)
├── agent/       # Azure OpenAI client, tool registry, prompt loader
├── providers/   # base Protocol + concrete backends (azure_devops, github, github_stub)
├── storage/     # SQLite schema + repos (items, comments, watchlist, FTS5)
├── config/      # Pydantic config models + setup wizard + paths
└── telemetry/   # structlog configuration

frontend/       # React + Vite + Bun web client (consumes /openapi.json)
tests/          # pytest; unit / integration / pilot (Textual run_test)
tests/fakes/    # FakeProvider + scripted LLM clients
tests/fixtures/ # pytest-recording cassettes
```

See [AGENTS.md](AGENTS.md) for the full architecture contract, non-negotiable rules, and testing conventions.

---

## Docs

- **[First-Time Setup Guide](.docs/FIRST_TIME_SETUP.md)** — install, wizard walkthrough, provider-specific prerequisites, troubleshooting
- **[AGENTS.md](AGENTS.md)** — contract for human and AI contributors: architecture guardrails, mutation surface pattern, testing conventions

---

## License

MIT — declared in [pyproject.toml](pyproject.toml).
