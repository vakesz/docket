# Docket

> **Terminal-first work-item triage — fast local cache, three-pane TUI, an AI assistant that asks before it writes, and an optional React web client.**

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![uv](https://img.shields.io/badge/packaging-uv-261230?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![Type-checked: mypy](https://img.shields.io/badge/type--checked-mypy%20strict-2a6db2?logo=python&logoColor=white)](https://mypy-lang.org/)
[![Lint: ruff](https://img.shields.io/badge/lint-ruff-261230?logo=ruff&logoColor=white)](https://docs.astral.sh/ruff/)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-ready-0078d7?logo=azuredevops&logoColor=white)](#providers)
[![GitHub](https://img.shields.io/badge/GitHub-ready-181717?logo=github&logoColor=white)](#providers)

Browse · Filter · Chat · Transition · Patch · Create — without leaving your terminal, or in a browser when you want one.

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

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the whole loop — the backlog, the selected item, and an LLM assistant — side-by-side in a Textual TUI you can run over SSH or in a tmux pane, and it keeps every write behind a visible confirm step. The same backend powers an optional React web client when a browser is what you want.

- **Local-first.** SQLite cache with FTS5 full-text search means browsing and filtering are instant, even when the remote provider is slow or unreachable.
- **Multi-provider.** One `WorkItemProvider` protocol, one canonical model. Ships with Azure DevOps, GitHub, and an in-memory `github_stub`. Third-party providers register through the `docket.providers` entry-point group.
- **Project-scoped.** One project per provider entry, with its own memory, sources, and MCP fleet. Switching providers in the TUI rebinds everything.
- **Safe by design.** Every mutation — CLI, TUI, HTTP, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode strips write tools from the agent and blocks every mutation endpoint.
- **Prompt-caching friendly.** The system + ticket-snapshot prefix is byte-stable across turns, so the Azure OpenAI prompt cache hits on every follow-up.

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
- Per-project memory (`m`), sources (`u`), and MCP servers (`Shift+M`)
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

# 2. Configure — provider, scope, telemetry, HTTP token, LLM, prompts, first sync
uv run docket setup

# 3. Launch the TUI
uv run docket
```

First run with no config falls straight into the wizard, so step 2 is optional if you're happy typing answers at step 3.

For the full walkthrough (Azure DevOps + GitHub auth, troubleshooting, where files land), see the **[First-Time Setup Guide](.docs/FIRST_TIME_SETUP.md)**.

---

## CLI reference

| Command | What it does |
| --- | --- |
| `docket` | Open the TUI (default when no subcommand is given) |
| `docket help [command]` | Command list with quick examples; pass a name for a focused view |
| `docket status [-v]` | Active project, paths, cache counts, sync state, MCP fleet, telemetry, HTTP — `-v` adds recent tool/proposal/MCP events from the log |
| `docket sync` / `sync --full` | Pull changes from the active provider |
| `docket list --kind story` | List cached items (filter by kind, state, assignee) |
| `docket show <id>` | Show one item's full detail |
| `docket new task --title "Follow up"` | Create a new item through the confirm gate |
| `docket transition <id> start_work --dry-run` | Preview a named transition; drop `--dry-run` to confirm |
| `docket patch <id> --from-file body.md --dry-run` | Preview a description update |
| `docket open --provider <key> [--scope <view>] [--no-chat] [--read-only]` | Open the TUI with explicit provider/scope/flags |
| `docket serve [--host …] [--port …] [--no-chat] [--read-only]` | Run the FastAPI HTTP surface (defaults to `127.0.0.1:8765`; bearer required) |
| `docket setup` / `setup --step=<name>` | Run or resume the setup wizard |
| `docket setup provider list \| add \| remove` | Manage configured providers without restarting the wizard |
| `docket project` / `memory` / `source` / `mcp` | Manage projects, project memory, sources, and per-project MCP servers |

Bare `docket` always runs the TUI — subcommands still work, and a missing `config.toml` auto-triggers the wizard.

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
- `c` — show/hide done items (persists to `config.ui.hide_done`)

### Meta

- `?` / `F1` / `h` — in-app help
- `,` — settings editor
- `p` — prompt library
- `m` — memory editor (per active project)
- `u` — sources editor (per active project)
- `Shift+M` — MCP servers (per active project)
- `Ctrl+T` — theme picker (live preview, persists on Enter)
- `q` — quit

---

## Web UI

Docket ships with a React web client in `frontend/` that consumes the FastAPI surface. It is optional — the TUI is the primary interface — but useful when you want a browser view of the same cache and chat.

```bash
make install   # uv sync + bun install (one-time)
make env       # mint a DOCKET_API_TOKEN into .env (one-time, dev only)
make dev       # run `docket serve` + vite dev server together
```

`make dev` brings up the backend on `http://127.0.0.1:8765` and the dev frontend on `http://localhost:3000`. The frontend's Bun server proxies `/api/*` to the backend with a bearer header attached server-side; the token never reaches the browser. Production: `make frontend-build` then `make frontend-start` runs the SSR bundle through Bun.

Regenerate the OpenAPI-typed client with `make gen-api` while the backend is running.

Stack: React 19, TanStack Start (SSR) + Router + Query, Vite, Tailwind 4, CodeMirror, Biome, Bun.

---

## Providers

| Provider | Auth | Scope filters | Notes |
| --- | --- | --- | --- |
| **Azure DevOps** (`azure_devops`) | `az login` | team, area path, iteration path, assignee | Production path. Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |
| **GitHub** (`github`) | `gh auth token`, `GITHUB_TOKEN` fallback | assignee | Issues + PRs mapped to the canonical model. `find_related_prs` agent tool scans recent PRs for id/keyword mentions. |
| **github_stub** (`github_stub`) | — | any | In-memory reference impl ("GitHub (in-memory)" in the wizard). Useful when you want to poke at the TUI without wiring a real backend. |

Adding Jira, Linear, or a custom system is a matter of satisfying the `WorkItemProvider` Protocol in `src/docket/providers/base.py`: implement `fetch_list`, `fetch_detail`, `transition`, `patch_description`, `upload_attachment`, and `create_item`, plus a state-map module that translates provider-native states to canonical `ItemState` / `TransitionIntent`. Register it with `register(...)` from `src/docket/providers/registry.py`, or ship it as a separate pip package that declares a `docket.providers` entry-point.

---

## Configuration

Docket stores everything under XDG paths resolved by `platformdirs`. On macOS without XDG overrides:

| Path (macOS) | Purpose |
| --- | --- |
| `~/Library/Application Support/docket/config.toml` | Providers, scopes, projects, LLM settings, HTTP token, UI preferences |
| `~/Library/Application Support/docket/.env` | Optional local secrets (Azure OpenAI key, etc.) |
| `~/Library/Application Support/docket/prompts/` | `system_base.md` + `kind_<kind>.md` — live-reloads on save |
| `~/Library/Application Support/docket/docket.db` | SQLite cache (items, comments, conversations, messages, watchlist, FTS5) |
| `~/Library/Caches/docket/logs/docket.log` | Rotating JSON log (1 MB × 3) |

Linux uses the usual `~/.config`, `~/.local/state`, `~/.cache`; Windows uses `%APPDATA%`. Every entry point honors `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` overrides — even on macOS — which is how the `.docket-dev/` redirect in `.env.example` keeps dev state out of your Library.

The setup wizard writes `config.toml` atomically after every step; partial runs are resumable via `docket setup --step=<name>` (`provider`, `auth`, `connection`, `scope`, `telemetry`, `http`, `llm`, `prompts`, `sync`, `default`).

### Environment variables worth knowing

Backend:

| Variable | Effect |
| --- | --- |
| `DOCKET_READ_ONLY=1` | Disable every mutation path — agent tools, CLI writes, TUI confirm modals, HTTP POSTs |
| `DOCKET_LOG_LEVEL` | Uvicorn log level for `docket serve` (`critical` … `debug` / `trace`; default `info`) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | Override `[llm].endpoint` / `[llm].deployment` from `config.toml` at runtime |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI client config; key has no `config.toml` home and stays in `.env` |
| `GITHUB_TOKEN` | Fallback for the GitHub provider when `gh auth token` isn't available |
| `DOCKET_PRICE_INPUT_PER_1M` / `DOCKET_PRICE_OUTPUT_PER_1M` | Per-1M-token pricing for the chat ledger; omit to hide the $ in the status bar |
| `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` | Override docket paths (tests use this to sandbox per-test) |

HTTP / frontend:

| Variable | Effect |
| --- | --- |
| `DOCKET_API_TOKEN` | Bearer override used by the frontend dev/prod server and CI; wins over `[http] token` in `config.toml`. Empty after setup is fine — `config.toml` is the source of truth. |
| `DOCKET_SETUP_TOKEN` | Bearer for the bootstrap-mode `/setup/*` surface (when `config.toml` is missing). `make env` mirrors `DOCKET_API_TOKEN` here. |
| `DOCKET_API_URL` | Frontend → backend URL when the backend isn't on the default `127.0.0.1:8765` |

`.env` lookup order (first hit wins): repo-local `.env` (walking up from CWD) → user-level `.env` under the docket config dir.

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
  ┌──────────┼──────────┐           │  memory · sources      │
  ▼          ▼          ▼           └────────────────────────┘
Azure DevOps  GitHub   github_stub
```

Core rules that hold this together:

- `core/`, `storage/`, `agent/`, and `api/` **must not** import concrete providers — they speak only to the `WorkItemProvider` Protocol. Enforced by `tests/unit/test_import_boundary.py`.
- **Named transition intents** (`TransitionIntent.CLOSE_DONE`, `.START_WORK`, …) are the canonical mutation vocabulary. Providers translate them to native state strings inside `state_map.py`.
- **Every mutation** — from a keystroke, a CLI flag, an HTTP POST, or an LLM tool call — goes through `mutation_service.propose → render_diff → confirm`. There is no shortcut.
- **Sources are read-only for the agent.** The agent gets `list_sources` / `read_source` / `search_sources` tools, but every source write is human-driven through the CLI / TUI / API.
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
make check                                              # lint + typecheck + test across both trees
```

Testing conventions:

- Tests live under three trees: `tests/unit/` (pure Python + architectural guards), `tests/integration/` (DB / FastAPI / Typer / services), `tests/pilot/` (Textual `run_test()`).
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
├── api/         # FastAPI app (items / conversations / mutations / SSE / setup)
├── core/        # canonical model + services (the single write gate)
├── agent/       # Azure OpenAI client, tool registry, prompt loader, MCP manager
├── providers/   # base Protocol + concrete backends (azure_devops, github, github_stub)
├── storage/     # SQLite schema + repos (items, comments, watchlist, memory, sources, FTS5)
├── config/      # Pydantic config models + setup wizard + paths + env loader
└── telemetry/   # structlog configuration + log reader

frontend/       # React + TanStack Start + Vite + Bun web client (consumes /openapi.json)
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
