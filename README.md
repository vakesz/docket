# Docket

> **Terminal-first work-item triage — fast local cache, three-pane TUI, an AI assistant that asks before it writes, and an optional React web client.**

Browse · Filter · Chat · Transition · Patch · Create — without leaving your terminal, or in a browser when you want one.

---

## Contents

- [Why Docket](#why-docket)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [TUI cheat sheet](#tui-cheat-sheet)
- [Web UI](#web-ui)
- [Providers](#providers)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Testing](#testing)
- [License](#license)

---

## Why Docket

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the backlog, the selected item, and an LLM assistant side-by-side in a Textual TUI you can run over SSH or in a tmux pane, and it keeps every write behind a visible confirm step. The same backend powers an optional React web client when a browser is what you want.

- **Local-first.** SQLite cache with FTS5 — browsing and filtering are instant even when the provider is slow.
- **Multi-provider.** One `WorkItemProvider` protocol, one canonical model. Ships with Azure DevOps, GitHub, and an in-memory `github_stub`. Third-party providers register through the `docket.providers` entry-point group.
- **Project-scoped.** One project per provider entry, with its own memory, sources, and MCP fleet. Switching providers in the TUI rebinds everything.
- **Safe by design.** Every mutation — CLI, TUI, HTTP, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode strips write tools from the agent and blocks every mutation endpoint.
- **Prompt-cache friendly.** The system + ticket-snapshot prefix is byte-stable across turns, so the LLM prompt cache hits on every follow-up.

---

## Quick start

```bash
git clone <repo-url> docket && cd docket
uv sync
uv run docket setup    # provider, scope, telemetry, HTTP token, LLM, prompts, first sync
uv run docket          # launch the TUI
```

First run with no config drops straight into the wizard, so `setup` is optional if you're happy answering at TUI launch.

---

## CLI reference

| Command | What it does |
| --- | --- |
| `docket` | Open the TUI (default when no subcommand is given) |
| `docket --help` | Typer's command list (also `docket <subcommand> --help` for one) |
| `docket status [-v]` | Active project, paths, cache counts, sync state, MCP fleet, telemetry, HTTP |
| `docket sync [--full]` | Pull changes from the active provider |
| `docket list --kind story` | List cached items (filter by kind, state, assignee) |
| `docket show <id>` | Show one item's full detail |
| `docket new task --title "Follow up"` | Create a new item through the confirm gate |
| `docket transition <id> start_work [--dry-run]` | Preview/apply a named transition |
| `docket patch <id> --from-file body.md [--dry-run]` | Preview/apply a description update |
| `docket open [--provider …] [--scope …] [--no-chat] [--read-only]` | Open the TUI with explicit flags |
| `docket serve [--host …] [--port …] [--no-chat] [--read-only]` | Run the FastAPI surface (default `127.0.0.1:8765`; bearer required) |
| `docket setup [--step=<name>]` | Run or resume the setup wizard |
| `docket project` / `memory` / `source` / `mcp` | Manage projects, project memory, sources, and per-project MCP servers |

Bare `docket` always runs the TUI; a missing `config.toml` auto-triggers the wizard.

---

## TUI cheat sheet

In-app help is always one keystroke away (`?` / `F1` / `h`). The essentials:

- **Navigate:** `Tab` / `Shift+Tab` panes · `/` filter · `:` open by id · `Ctrl+F` maximize · `Ctrl+P` palette
- **Act:** `r` sync · `n` new item · `t` new chat · `s` suggest action · `o` open in browser · `w` pin · `d` review proposals · `c` toggle done
- **Config:** `,` settings · `p` prompts · `m` memory · `u` sources · `Shift+M` MCP servers · `Ctrl+T` theme · `q` quit

---

## Web UI

Docket ships with a React web client in `frontend/` that consumes the FastAPI surface. The TUI is the primary interface — the web client is optional.

```bash
make install   # uv sync + bun install (one-time)
make env       # mint a DOCKET_API_TOKEN into .env (one-time, dev only)
make serve     # build the SPA and run the backend serving it (single process, single origin at 127.0.0.1:8765)
```

- **Iterating on the SPA:** re-run `make frontend-build` (or `make serve`) and refresh the browser. Vite emits straight into `src/docket/frontend_dist/`; there is no separate frontend dev server. The bearer is injected into `index.html` at request time as `window.__DOCKET_TOKEN__` and never leaves the local box.
- **Wheel (`make wheel`):** builds the SPA into the same path, then runs `uv build --wheel`, producing one installable artifact with the SPA bundled inside.

All backend routes live under `/api/*` — anything outside that prefix is claimed by the SPA catch-all. Regenerate the OpenAPI client with `cd frontend && bun run gen:api` while the backend is running.

Stack: React 19, TanStack Router + Query, Vite, Tailwind 4, CodeMirror, Biome, Bun (dev tooling only). See [AGENTS.md](AGENTS.md) for the dist-resolution order and other operational details.

---

## Providers

| Provider | Auth | Notes |
| --- | --- | --- |
| **Azure DevOps** (`azure_devops`) | `az login` | Production path. Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |
| **GitHub** (`github`) | `gh auth token`, `GITHUB_TOKEN` fallback | Issues + PRs mapped to the canonical model. `find_related_prs` agent tool scans recent PRs for id/keyword mentions. |
| **github_stub** | — | In-memory reference impl. Useful for poking at the TUI without a real backend. |

To add Jira, Linear, or anything else: implement the `WorkItemProvider` Protocol in `src/docket/providers/base.py` (`fetch_list`, `fetch_detail`, `transition`, `patch_description`, `upload_attachment`, `create_item`) plus a state-map module that translates native states to canonical `ItemState` / `TransitionIntent`. Register via `register(...)` in `src/docket/providers/registry.py`, or ship as a separate package with a `docket.providers` entry-point.

---

## Configuration

Docket stores everything under XDG paths resolved by `platformdirs`. `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` overrides are honored everywhere — including macOS — which is how `.env.example`'s `.docket-dev/` redirect keeps dev state out of `~/Library`.

Key files: `config.toml` (providers, scopes, projects, LLM, HTTP token, UI prefs), `.env` (optional secrets like `AZURE_OPENAI_API_KEY`), `prompts/` (`system_base.md` + `kind_<kind>.md`, hot-reloaded), `docket.db` (SQLite cache), `logs/docket.log` (rotating JSON, 1 MB × 3).

The setup wizard writes `config.toml` atomically after every step; partial runs resume via `docket setup --step=<name>` (`provider`, `auth`, `connection`, `label`, `scope`, `telemetry`, `http`, `llm`, `prompts`, `sync`, `default`).

### Environment variables

| Variable | Effect |
| --- | --- |
| `DOCKET_READ_ONLY=1` | Disable every mutation path (agent, CLI, TUI, HTTP) |
| `DOCKET_LOG_LEVEL` | Uvicorn log level for `docket serve` (default `info`) |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_DEPLOYMENT` | Override `[llm]` from `config.toml` at runtime |
| `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_API_VERSION` | Azure OpenAI client config; key has no `config.toml` home and stays in `.env` |
| `GITHUB_TOKEN` | Fallback for the GitHub provider when `gh auth token` isn't available |
| `DOCKET_PRICE_INPUT_PER_1M` / `DOCKET_PRICE_OUTPUT_PER_1M` | Per-1M-token pricing for the chat ledger; omit to hide the $ in the status bar |
| `DOCKET_API_TOKEN` | Bearer used by the frontend dev/prod server and CI; wins over `[http] token`. Empty after setup is fine. |
| `DOCKET_SETUP_TOKEN` | Bearer for bootstrap-mode `/setup/*` (when `config.toml` is missing). `make env` mirrors `DOCKET_API_TOKEN` here. |
| `DOCKET_API_URL` | Frontend → backend URL when the backend isn't on the default `127.0.0.1:8765` |

`.env` lookup order: repo-local `.env` (walking up from CWD) → user-level `.env` under the docket config dir.

---

## Architecture

Surfaces (`cli/` Typer, `cli/tui/` Textual, `api/` FastAPI + SSE) are thin adapters that call into `core/services/` — the single write gate. Services talk to providers via the `WorkItemProvider` Protocol in `providers/base.py` and to SQLite via repos in `storage/`. Concrete providers live behind the protocol: `azure_devops`, `github`, `github_stub`.

For the full contract — invariants, the proposal-first mutation pattern, tool-registration order, testing conventions — see [AGENTS.md](AGENTS.md).

---

## Testing

```bash
uv run pytest          # full suite (async auto-mode)
make check             # lint + typecheck + test across both trees
```

Test layout, fixtures, and the architectural guards are documented in [AGENTS.md](AGENTS.md).

---

## Docs

- **[First-Time Setup Guide](.docs/FIRST_TIME_SETUP.md)** — install, wizard walkthrough, provider prerequisites, troubleshooting
- **[AGENTS.md](AGENTS.md)** — architecture guardrails, mutation surface pattern, testing conventions

---

## License

MIT — see [pyproject.toml](pyproject.toml).
