<div align="center">

# Docket

**Terminal-first work-item triage — fast local cache, three-pane TUI, and an AI assistant that asks before it writes.**

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python&logoColor=white)](https://www.python.org/)
[![uv](https://img.shields.io/badge/packaging-uv-261230?logo=python&logoColor=white)](https://docs.astral.sh/uv/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Type-checked: mypy](https://img.shields.io/badge/type--checked-mypy%20strict-2a6db2?logo=python&logoColor=white)](https://mypy-lang.org/)
[![Lint: ruff](https://img.shields.io/badge/lint-ruff-261230?logo=ruff&logoColor=white)](https://docs.astral.sh/ruff/)
[![Tests](https://img.shields.io/badge/tests-327%20passing-brightgreen)](#testing)
[![Azure DevOps](https://img.shields.io/badge/Azure%20DevOps-ready-0078d7?logo=azuredevops&logoColor=white)](#providers)
[![GitHub](https://img.shields.io/badge/GitHub-ready-181717?logo=github&logoColor=white)](#providers)
[![Status: phase-2 landed](https://img.shields.io/badge/status-phase%202%20landed-success)](#roadmap)

Browse · Filter · Chat · Transition · Patch · Create — without leaving your terminal.

</div>

---

## Why Docket

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the whole loop — the backlog, the selected item, and an LLM assistant — side-by-side in a Textual TUI you can run over SSH or in a tmux pane, and it keeps every write behind a visible confirm step.

- **Local-first.** SQLite cache with FTS5 full-text search means browsing and filtering are instant, even when the remote provider is slow or unreachable.
- **Multi-provider.** One `WorkItemProvider` protocol, one canonical model. Ships with Azure DevOps and GitHub live, plus a `github_stub` for tests and demos. Swap providers from the command palette.
- **Safe by design.** Every mutation — CLI, TUI, HTTP, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode hides write tools from the agent entirely.
- **Prompt-caching friendly.** The system/kind prefix is byte-stable across turns, so Azure AI Foundry's prompt cache hits on every follow-up.

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
| `~/Library/Application Support/docket/.env` | optional local secrets (Foundry key, etc.) |
| `~/Library/Application Support/docket/prompts/` | `system_base.md` + `kind_<kind>.md` — live-reloads on save |
| `~/Library/Caches/docket/docket.db` | SQLite cache (items, comments, messages, watchlist, FTS5) |
| `~/Library/Logs/docket/` | structlog output |

Linux and Windows resolve to their usual XDG equivalents. The setup wizard writes `config.toml` atomically after every step; partial runs are resumable via `docket setup --step=<name>`.

### Environment variables worth knowing

| Variable | Effect |
| --- | --- |
| `DOCKET_READ_ONLY=1` | Disable every mutation path — agent tools, CLI writes, TUI confirm modals |
| `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_API_VERSION` | Foundry client config; `.env` takes precedence over `config.toml` |
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

- `core/`, `storage/`, `agent/`, and `api/` **must not** import concrete providers — they speak only to the `WorkItemProvider` Protocol. Enforced by `tests/test_import_boundary.py`.
- **Named transition intents** (`TransitionIntent.CLOSE_DONE`, `.START_WORK`, …) are the canonical mutation vocabulary. Providers translate them to native state strings inside `state_map.py`.
- **Every mutation** — from a keystroke, a CLI flag, an HTTP POST, or an LLM tool call — goes through `mutation_service.propose → render_diff → confirm`. There is no shortcut.
- **The prompt prefix is cache-stable**: `[system + kind template] → [ticket snapshot] → ---` is byte-identical across turns, so Foundry prompt caching hits on every follow-up.

These invariants are enforced by tests — `test_import_boundary.py`, `test_state_map_reverse.py`, and the per-provider cross-cutting suites in `tests/test_github_stub_provider.py` — so a refactor that violates one fails loudly.

---

## Testing

```bash
uv run pytest                         # 327 tests, async auto-mode
uv run pytest tests/test_foo.py       # one file
uv run pytest tests/test_foo.py::bar  # one test
uv run pytest -k "pattern"            # by name
uv run ruff check . && uv run ruff format .
uv run mypy src                       # strict
```

Testing conventions:

- **TUI tests are pilot-style** — mount `ItvApp` with a `FakeProvider` via `app.run_test()` and drive with `pilot.press(...)`. Don't assert on CSS or private widget state.
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
├── agent/               # Foundry client, tool registry, prompt loader
├── providers/           # base Protocol + concrete backends
├── storage/             # SQLite schema + repos (items, comments, watchlist, FTS5)
└── config/              # Pydantic config models + setup wizard + paths

tests/                   # pytest; TUI tests use Textual pilot
tests/fakes/             # FakeProvider + scripted LLM clients
tests/fixtures/cassettes # pytest-recording cassettes
```

---

## Adding a provider

Every backend plugs in through one Protocol (`src/docket/providers/base.py`). Start from the in-memory reference — `src/docket/providers/github_stub/` — and copy its shape. The contract is small:

```python
class WorkItemProvider(Protocol):
    def health_check(self) -> None: ...
    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]: ...
    def get_item(self, id: str) -> Item: ...
    def get_comments(self, id: str) -> list[Comment]: ...
    def get_linked(self, id: str) -> list[Item]: ...
    def transition(self, id: str, intent: TransitionIntent) -> Item: ...
    def patch_description(self, id: str, new_md: str) -> Item: ...
    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str: ...
    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item: ...
```

Four rules that keep providers safe to compose:

1. **Translate at the boundary.** Native state strings stay inside the provider — every `Item` you yield has a canonical `ItemState`. Two dicts do most of the work: `NATIVE_TO_CANONICAL: dict[NativeT, ItemState]` and `INTENT_TO_NATIVE: dict[TransitionIntent, NativeT]`. `to_canonical` must total (pick a safe fallback for unknown states), and `to_native` must cover every `TransitionIntent`.
2. **Raise the shared errors.** `ProviderUnreachableError`, `ProviderAuthError`, and `ProviderError` from `providers/base.py` — so the CLI, TUI, and API render failures uniformly.
3. **Stay stateless.** The cache, watermarks, and transcripts are core concerns. The provider is a thin adapter between one REST call and one canonical object.
4. **Opt in to optional capabilities via method presence.** The agent tool for `find_related_prs` is only registered when the active provider exposes the method — no declaration gymnastics, `getattr(provider, "find_related_prs", None)` is the gate.

Checklist for a new provider named `foo`:

- `src/docket/providers/foo/__init__.py` + `provider.py` + `state_map.py` (re-export `FooProvider`)
- Register in `src/docket/config/` and the setup wizard (`src/docket/cli/setup/`) — ADO is the selection shape to copy
- Put auth in `providers/foo/auth.py`, raising `ProviderAuthError` on failure so the wizard can re-prompt
- Satisfy the cross-cutting tests (see [Testing](#testing))

Performance: `sync_service.refresh` calls `item_repo.upsert_items` with `executemany` — don't call `upsert_item` in a loop from the provider. `list_changes_since` should paginate internally and yield items so peak memory stays flat. Keep `provider_raw` small; it's JSON-serialized on every upsert.

---

## Roadmap

Docket is in active phase-2 development. M1–M16 have landed; comment draft queue is carved out of M16 as a follow-up:

| Phase | Status | Highlights |
| --- | --- | --- |
| Phase 1 (M1–M8) | ✅ landed | Provider abstraction, canonical model, SQLite cache, TUI shell, service layer, CLI surface, Foundry wiring, diff-preview mutations |
| Phase 2 (M9–M16) | ✅ landed | Multi-provider config, GitHub provider, setup wizard, prompt library, background sync, read-only mode, draft proposal queue, watchlist + PR discovery |
| Follow-up | pending | Comment draft queue (M16 carve-out), Jira/Linear providers, richer linked-item graph |

Invariants enforced by tests — don't violate them without updating the tests too:

- `tests/test_import_boundary.py` — `core/`, `storage/`, `agent/`, `api/` must not import concrete providers
- `tests/test_state_map_reverse.py` — every `TransitionIntent` round-trips through every provider's state map
- `tests/test_github_stub_provider.py` — the reference cross-cutting suite every provider should pass

---

## Contributing

Before opening a PR:

1. Keep the layered dependency rule intact — `tests/test_import_boundary.py` fails loudly if you break it.
2. If you add a provider, copy the cross-cutting tests from `tests/test_github_stub_provider.py` and point them at your provider.
3. Run `uv run ruff check . && uv run mypy src && uv run pytest` before pushing.
4. New mutations must flow through `mutation_service.propose` → diff → confirm. No exceptions for "it's just a CLI flag."

## Docs

- 📘 **[First-Time Setup Guide](docs/FIRST_TIME_SETUP.md)** — install, wizard walkthrough, provider-specific prerequisites, troubleshooting
- 🤖 **[CLAUDE.md](CLAUDE.md)** — conventions for AI assistants working in this repo

## License

MIT — see [pyproject.toml](pyproject.toml).
