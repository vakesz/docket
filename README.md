<div align="center">

# Docket

**Terminal-first work-item triage — fast local cache, three-pane TUI, and an AI assistant that asks before it writes.**

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![uv](https://img.shields.io/badge/packaging-uv-261230?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![Type-checked: mypy](https://img.shields.io/badge/type--checked-mypy%20strict-2a6db2?logo=python&logoColor=white)](https://mypy-lang.org/)
[![Lint: ruff](https://img.shields.io/badge/lint-ruff-261230?logo=ruff&logoColor=white)](https://docs.astral.sh/ruff/)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-ready-0078d7?logo=azuredevops&logoColor=white)](#providers)
[![GitHub](https://img.shields.io/badge/GitHub-ready-181717?logo=github&logoColor=white)](#providers)

Browse · Filter · Chat · Transition · Patch · Create — without leaving your terminal.

</div>

---

## Why Docket

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the whole loop — the backlog, the selected item, and an LLM assistant — side-by-side in a Textual TUI you can run over SSH or in a tmux pane, and it keeps every write behind a visible confirm step.

- **Local-first.** SQLite cache with FTS5 full-text search means browsing and filtering are instant, even when the remote provider is slow or unreachable.
- **Multi-provider.** One `WorkItemProvider` protocol, one canonical model. Ships with Azure DevOps and GitHub live, plus a `github_stub` for tests and demos. Swap providers from the command palette.
- **Safe by design.** Every mutation — CLI, TUI, HTTP, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode hides write tools from the agent entirely.
- **Prompt-caching friendly.** The system/kind prefix is byte-stable across turns, so the Azure OpenAI prompt cache hits on every follow-up.

---

## Feature tour

<table>
<tr>
<td width="50%" valign="top">

### Browse & navigate
- Three resizable panes: backlog, detail, assistant
- Live filter (FTS5 over title, description, comments)
- Quick-open by id (`:`)
- Fullscreen any pane (`Ctrl+F`)
- Theme picker with live preview (`Ctrl+T`)
- Command palette for every action (`Ctrl+P`)
- Stale marker (`STALE — Xd`) after a configurable threshold

### Pin & focus
- Watchlist pins survive scope and view switches (`w`)
- Pinned section always at the top of the tree
- Join on live items — archived pins drop out silently

</td>
<td width="50%" valign="top">

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

</td>
</tr>
</table>

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

### Everyday commands

| Command | Alias | What it does |
| --- | --- | --- |
| `docket` | — | Open the TUI |
| `docket help` | — | Command list + examples |
| `docket sync` | `refresh` | Pull changes from the provider |
| `docket list` | `ls` | List cached items (supports `--kind`) |
| `docket show <id>` | `view` | Show one item's full detail |
| `docket new task --title "Follow up"` | `create` | Create with confirm gate |
| `docket transition <id> start_work --dry-run` | — | Propose a named transition |
| `docket patch <id> --from-file body.md` | — | Preview a description update |
| `docket open` | `browse`, `ui` | Same as `docket` |
| `docket serve` | — | Run the local HTTP API |
| `docket setup` | — | Re-run or resume the wizard |
| `docket setup provider add <name>` | — | Register an additional provider |

Bare `docket` always runs the TUI — subcommands still work, and a missing config auto-triggers the wizard.

---

## TUI cheat sheet

<table>
<tr><td>

**Navigation**
- `Tab` / `Shift+Tab` — next/previous pane
- `/` — focus the filter
- `:` — quick-open by id
- `Ctrl+F` — maximize/restore the focused pane
- `Ctrl+Left` / `Ctrl+Right` — resize the focused pane
- `Ctrl+P` — command palette

</td><td>

**Actions**

- `r` — refresh (sync now)
- `n` — new item
- `t` — new chat thread
- `s` — suggest next action
- `o` — open item in browser
- `w` — pin/unpin the focused item
- `d` — review pending proposals

</td><td>

**Meta**

- `?` or `F1` — in-app help
- `,` — settings editor
- `p` — prompt library
- `Ctrl+T` — theme picker
- `q` — quit

</td></tr>
</table>

---

## Providers

| Provider | Auth | Scope filters | Notes |
| --- | --- | --- | --- |
| **Azure DevOps** (`azure_devops`) | `az login` | team, area path, iteration path, assignee | Production path. Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |
| **GitHub** (`github`) | `gh auth token`, `GITHUB_TOKEN` fallback | assignee | Issues + PRs mapped to the canonical model. `find_related_prs` agent tool scans recent PRs for id/keyword mentions. |
| **github_stub** (`github_stub`) | — | any | In-memory reference impl for tests and demos. Useful when you want to poke at the TUI without wiring a real backend. |

Adding Jira, Linear, or a custom system is a matter of satisfying the `WorkItemProvider` Protocol — see [Adding a provider](#adding-a-provider) below. Third-party providers can ship as separate pip packages via the `docket.providers` entry-point group.

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

## Architecture at a glance

```
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
uv run pytest                              # ~370 tests, async auto-mode
uv run pytest tests/integration/test_api.py    # one file
uv run pytest tests/integration/test_api.py::test_name  # one test
uv run pytest -k "pattern"                 # by name
uv run ruff check . && uv run ruff format .
uv run mypy src                            # strict
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

```
src/docket/
├── cli/                 # typer entrypoint + commands + Textual TUI
├── api/                 # FastAPI app (items / conversations / SSE stream)
├── core/                # canonical model + services (the single write gate)
├── agent/               # Azure OpenAI client, tool registry, prompt loader
├── providers/           # base Protocol + concrete backends
├── storage/             # SQLite schema + repos (items, comments, watchlist, FTS5)
└── config/              # Pydantic config models + setup wizard + paths

tests/                   # pytest; TUI tests use Textual pilot
tests/fakes/             # FakeProvider + scripted LLM clients
tests/fixtures/cassettes # pytest-recording cassettes
```

---

## Docs

- 📘 **[First-Time Setup Guide](.docs/FIRST_TIME_SETUP.md)** — install, wizard walkthrough, provider-specific prerequisites, troubleshooting

## License

MIT — see [pyproject.toml](pyproject.toml).
