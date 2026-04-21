# Docket — implementation plan

> Status: agreed 2026-04-21. This is the source of truth for architecture and scope. Changes should be made here before code lands.

## 1. Repo layout

```
docket/
├── pyproject.toml                 # uv, ruff, pytest, entrypoint `docket`
├── src/docket/
│   ├── __main__.py                # `python -m docket`
│   ├── cli/                       # thin CLI adapter
│   │   ├── app.py                 # typer/click root
│   │   ├── commands/              # new, list, open, sync, config, setup, serve
│   │   └── tui/                   # Textual app
│   ├── api/                       # FastAPI adapter
│   │   ├── app.py                 # app factory
│   │   ├── auth.py                # static bearer
│   │   ├── routes/                # items, conversations, stream (SSE)
│   │   └── schemas.py             # Pydantic DTOs
│   ├── core/                      # provider-agnostic domain
│   │   ├── model.py               # Item, Comment, Transition, Conversation, Message
│   │   ├── services/              # item_service, conversation_service, sync_service, mutation_service
│   │   ├── mutation.py            # diff-preview + confirm pipeline
│   │   └── intents.py             # named transition intents
│   ├── providers/
│   │   ├── base.py                # WorkItemProvider ABC
│   │   └── azure_devops/          # AzureDevOpsProvider, state_map, field_map, html_md roundtrip
│   ├── agent/
│   │   ├── foundry_client.py      # Azure AI Foundry (SSE, prompt caching)
│   │   ├── tools.py               # tool registry — targets provider interface
│   │   ├── prompts/               # editable .md templates per item kind
│   │   ├── session.py             # conversation loop, compaction
│   │   └── mcp_bridge.py          # optional: Azure DevOps MCP for context fetches
│   ├── storage/
│   │   ├── db.py                  # sqlite connection, migrations
│   │   ├── schema/                # per-version DDL
│   │   └── repos/                 # item_repo, conversation_repo, sync_repo
│   ├── config/
│   │   ├── loader.py              # $XDG_CONFIG_HOME/docket/config.toml
│   │   ├── env.py                 # .env loading
│   │   └── setup_wizard.py        # first-launch + `docket setup` flow
│   └── telemetry/
│       ├── logging.py             # structured JSON to $XDG_CACHE_HOME/.../logs/
│       └── ledger.py              # token/cost per conversation
└── tests/
    ├── fixtures/cassettes/        # VCR for ADO
    ├── fakes/foundry.py           # scripted LLM replies
    └── …
```

**Invariant:** nothing in `core/`, `cli/`, `api/`, or `storage/` imports from `providers/azure_devops/` directly — only through `providers.base`. Enforced by a test.

## 2. Tooling & `pyproject.toml`

Single source of truth for package metadata, runtime deps, dev tools, and entrypoint. Managed with `uv`. No `setup.py`, no `requirements.txt`, no scattered tool config files.

```toml
[project]
name = "docket"
version = "0.1.0"
description = "Terminal work-item triage with LLM chat and safe mutations"
requires-python = ">=3.12"
readme = "README.md"

dependencies = [
    "azure-devops>=7.1",          # ADO SDK
    "openai>=1.50",               # Foundry (OpenAI-compatible endpoint)
    "textual>=0.80",              # TUI
    "fastapi>=0.115",
    "uvicorn[standard]>=0.30",
    "sse-starlette>=2.1",         # SSE streaming
    "typer>=0.12",                # CLI
    "pydantic>=2.7",
    "pydantic-settings>=2.4",
    "python-dotenv>=1.0",
    "httpx>=0.27",
    "tomli-w>=1.0",               # config writes; reads via stdlib tomllib
    "rich>=13.7",
    "markdownify>=0.12",          # HTML → MD fallback
    "markdown-it-py>=3.0",        # MD → HTML fallback
    "platformdirs>=4.0",          # XDG / per-OS paths
    "structlog>=24.1",            # structured logs
]

[project.scripts]
docket = "docket.cli.app:main"

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.24",
    "pytest-recording>=0.13",     # VCR-style cassettes for ADO
    "ruff>=0.6",
    "mypy>=1.11",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.ruff]
line-length = 100
target-version = "py312"
[tool.ruff.lint]
select = ["E", "F", "I", "N", "UP", "B", "SIM", "RUF"]

[tool.pytest.ini_options]
addopts = "-ra --strict-markers"
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.mypy]
python_version = "3.12"
strict = true
plugins = ["pydantic.mypy"]
```

**Dev workflow:**

```bash
uv sync --all-extras      # venv + runtime + dev deps
uv run docket                # run the CLI entrypoint
uv run pytest
uv run ruff check .
uv run ruff format .
uv run mypy src
```

Package installed via `pipx install docket` once published.

## 3. Canonical data model (`core/model.py`)

```python
class ItemKind(StrEnum):         EPIC; FEATURE; STORY; TASK; BUG
class ItemState(StrEnum):        NEW; ACTIVE; BLOCKED; NEEDS_INFO; RESOLVED; CLOSED
class TransitionIntent(StrEnum): START_WORK; PAUSE; BLOCK; NEEDS_INFO; CLOSE_DONE; CLOSE_WONTFIX; REOPEN

@dataclass Item:         id; kind; title; description_md; state; assignee; parent_id; tags; updated_at; url; provider_raw
@dataclass Comment:      id; author; body_md; created_at
@dataclass Conversation: id; item_id; started_at; archived_at|None; token_cost_cents
@dataclass Message:      id; conversation_id; role; content; tool_calls; tokens_in; tokens_out; created_at
```

Provider `field_map` converts `provider_raw` ↔ canonical. ADO-specific HTML↔Markdown handled in provider, not core.

## 4. Provider interface (`providers/base.py`)

```python
class WorkItemProvider(Protocol):
    def health_check(self) -> None
    def list_changes_since(self, watermark: datetime, filters: ScopeFilters) -> Iterable[Item]
    def get_item(self, id: str) -> Item
    def get_comments(self, id: str) -> list[Comment]
    def get_linked(self, id: str) -> list[Item]
    def transition(self, id: str, intent: TransitionIntent) -> Item
    def patch_description(self, id: str, new_md: str) -> Item
    def upload_attachment(self, id: str, filename: str, content: bytes, content_type: str) -> str
    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item
```

`AzureDevOpsProvider` implements via `azure-devops` SDK. State mapping lives in `providers/azure_devops/state_map.py` (canonical ↔ ADO state strings per work-item-type). Markdown → ADO description: write directly; if ADO project is HTML-only, warn on first write and fall back to a converter.

## 5. SQLite schema (v1)

```sql
PRAGMA application_id = 0x49545600;  -- 'ITV\0'
PRAGMA user_version = 1;

items(id TEXT PK, kind, title, description_md, state, assignee, parent_id,
      tags_json, provider_raw_json, updated_at, synced_at, archived INT)
comments(id PK, item_id FK, author, body_md, created_at)
conversations(id PK, item_id FK, started_at, archived_at, tokens_in, tokens_out, cost_cents)
messages(id PK, conversation_id FK, role, content, tool_calls_json, tokens_in, tokens_out, created_at)
attachments(id PK, item_id FK, conversation_id FK, filename, remote_url, uploaded_at)
sync_state(scope_key PK, watermark_iso, last_full_sync_at)

INDEX on items(updated_at), items(kind, archived),
      messages(conversation_id, created_at), conversations(item_id, archived_at)
```

Migrations keyed off `PRAGMA user_version`; each version a forward-only `.sql` in `storage/schema/`.

## 6. Service layer (`core/services/`)

- `sync_service.refresh(filters)` — calls `provider.list_changes_since(watermark)`, upserts into SQLite, bumps watermark. Called at startup and on demand.
- `item_service.list(filters, …)` / `.get(id)` — reads from cache; on cache miss, falls through to provider.
- `conversation_service.open(item_id)` — resumes active thread or creates one; loads last N messages; triggers compaction if over threshold.
- `mutation_service.propose(intent)` → `MutationProposal` (typed diff/preview) → `.confirm(proposal)` executes via provider. Same pipeline for CLI, TUI, HTTP, and agent tool-calls.
- `external_update_merge`: every N seconds in TUI, re-fetch open item; if `updated_at` advanced, inject a system message into the live conversation: "Ticket changed externally: [diff]. Reconsider current conclusions."

## 7. LLM agent (`agent/`)

- **Foundry client** — `openai` SDK pointed at Foundry endpoint; API key from `.env`. Streaming on. Prompt layout:
  ```
  [system: role + item-kind template]
  [tools schema]
  [ticket snapshot: description + comments + linked items]   ← prefix ends here (cached)
  ---
  [conversation messages so far]
  ```
  Everything up to the `---` is the cacheable prefix; item snapshot is re-rendered only when the source changes. Cache-key stability is a first-class concern.
- **Tool registry**:
  - `get_linked_items`, `get_comments`, `search_items` — read-only; hit cache → provider.
  - `propose_transition(intent)`, `propose_description_patch(new_md)`, `propose_new_item(kind, fields)`, `attach_transcript()` — mutating; **all** funnel into `mutation_service.propose` → user confirm in TUI/CLI.
- **MCP bridge** — optional adapter so the same tools can be exposed via Azure DevOps MCP when the agent prefers that shape; off by default in phase 1.
- **Compaction** — when `tokens_in + history` > threshold (say 60k), summarize oldest turns into a pinned "earlier in this thread" block, persist the summary to `messages` with a `summary` role, drop raw replaced turns from the active prompt but keep them in SQLite for the transcript upload.
- **Suggested-next-action** — structured-output call (JSON schema: `{intent, description_patch_md, open_questions[]}`). User accepts/rejects atomically.

## 8. Mutation pipeline (`core/mutation.py`)

```python
Proposal = StateChange | DescriptionPatch | AttachmentUpload | ItemCreate
def propose(...) -> Proposal
def render_diff(Proposal) -> str           # md diff for description, arrow for transitions
def confirm(Proposal, *, dry_run: bool) -> Result
```

- Single code path for all writes. `dry_run=True` logs the would-be call and returns without hitting the provider.
- TUI renders `render_diff` in a modal with `[y] confirm / [n] reject / [e] edit`.
- CLI commands and agent tool-calls go through the same modal when interactive; agent tool-calls in a headless FastAPI context return the proposal to the HTTP caller (who must confirm on a second request).

## 9. TUI (`cli/tui/`)

- Textual app, three panes:
  - **Left**: tree/list (Epic → Feature → Story → Task/Bug), filterable. Keys: `/` fuzzy find, `r` refresh, `n` new item.
  - **Center**: item detail — title, metadata, description rendered Markdown, comments.
  - **Right**: chat pane — streamed tokens, tool-call markers, token/cost footer.
- Keybinds: `j/k` or arrows to navigate, `enter` to open chat, `t` new thread (archive current), `d` diff preview for pending mutation, `y/n` confirm/reject, `s` suggested-next-action, `?` help.
- External-update watcher: badge on the current item when remote changed; auto-merge on next send.

## 10. FastAPI (`api/`)

- Enabled/disabled via config. When enabled, bound to `127.0.0.1:8765` by default (configurable).
- Auth: `Authorization: Bearer <token>` middleware, token from config (generated on first launch).
- Routes:
  - `GET /items`, `GET /items/{id}`, `GET /items/{id}/comments`, `GET /items/{id}/linked`
  - `POST /items` (create, dry-run supported via query param)
  - `POST /items/{id}/mutations/propose` → returns `Proposal{id, diff}`
  - `POST /items/{id}/mutations/{proposal_id}/confirm` → executes
  - `GET /items/{id}/conversation` — list messages
  - `POST /items/{id}/conversation/messages` — send user message; response is **SSE** stream of tokens + tool events
  - `POST /items/{id}/conversation/thread` — new thread
- OpenAPI schema served at `/openapi.json`.

## 11. First-launch wizard (`config/setup_wizard.py`)

Runs automatically when `docket` starts without a config, and reusable via `docket setup`.

Steps, each independently retryable and resumable:

1. **Azure CLI check** — `az account show`; if missing, instruct `az login` and wait.
2. **ADO connection** — prompt org URL + project; test via `list_projects`.
3. **Scope filters** — prompt team / area path / iteration / assignee filters; show count of items matched; let user accept/redo.
4. **Work item type / state probing** — probe the ADO process template to build canonical ↔ provider state map; detect whether description supports Markdown. Persist results.
5. **Foundry setup** — prompt endpoint + model deployment name; prompt API key; offer to write to `$XDG_CONFIG_HOME/docket/.env`; do a small test call.
6. **HTTP surface** — ask enable/disable; if enable, generate bearer token, show it once, write to config; confirm bind address/port.
7. **Telemetry** — on by default, local-only at `$XDG_CACHE_HOME/docket/`; show path, let user opt out.
8. **Prompt templates** — scaffold per-kind `.md` templates in `$XDG_CONFIG_HOME/docket/prompts/`; tell user how to edit.
9. **DB init + initial sync** — create SQLite, run initial full sync within the configured scope; show count synced.
10. **Smoke test** — run one end-to-end dry-run: pick an item, open agent, get a greeting, close without writes.

Wizard writes `config.toml` atomically only after all steps complete; partial runs are resumable.

Recovery: if any component fails later (token revoked, API key expired, ADO access lost), the error handler points the user back to the specific wizard step via `docket setup --step=foundry` etc.

## 12. Phased milestones

Each milestone shippable and manually testable end-to-end.

- **M1 — Skeleton + config + DB**: repo, uv, entrypoint, config loader, SQLite migrations, wizard steps 1–3 + 7–9 wired, no LLM yet. Exit: `docket sync` pulls ADO items into cache.
- **M2 — Provider + service layer**: canonical model, `AzureDevOpsProvider`, `item_service`, `sync_service`, `mutation_service` (no agent yet). CLI: `docket list`, `docket show`, `docket transition`, `docket patch` (all with dry-run + confirm). Exit: full mutation pipeline tested against ADO with cassettes.
- **M3 — TUI read-only**: Textual app, three-pane layout, list/detail browsing, no chat yet. Exit: nav and search feel good.
- **M4 — Agent + chat**: Foundry client, prompt caching, tool registry, conversation persistence, chat pane streaming. Read-only tools first. Exit: can triage an item by chatting; transcript persists.
- **M5 — Mutating tools + attachment upload**: agent can `propose_*`; modal confirmations; transcript versioned upload. Exit: full triage → close flow via chat.
- **M6 — FastAPI**: REST + SSE, bearer auth, disable toggle. Exit: can drive the whole thing over HTTP.
- **M7 — External-update merge + compaction**: watcher, summary-role messages, suggested-next-action structured output. Exit: long conversations don't blow the context; external edits surface cleanly.
- **M8 — Polish**: prompt template hot-reload, second provider stub (just the interface + a fake) to prove abstraction holds, perf pass on sync, docs for adding Jira/GitHub.

## 13. Risks to track

- **ADO description field**: if a project's process template uses HTML-only description, "always Markdown" breaks round-trips. Detect and warn during wizard; fall back to HTML↔MD converter with a flag in `sync_state`.
- **Foundry prompt caching eligibility**: confirm GPT-5 on the chosen deployment supports prompt caching and the cacheable-prefix size fits. Worst case: we pay full prompt every turn until the deployment supports it — design still works, just costs more.
- **MCP vs direct SDK for LLM tools**: starting with the direct provider-interface path; MCP bridge is additive. If the Azure DevOps MCP turns out to expose richer context than the SDK, we flip it via config.
- **Provider abstraction drift**: easy to leak ADO concepts into `core/` under deadline pressure. Add a lint/test that `core/**` doesn't import `providers.azure_devops.*`.

## 14. Key decisions (locked 2026-04-21)

| Area | Decision |
| --- | --- |
| Language | Python ≥ 3.12, `uv`, `pipx`, entrypoint `docket` |
| LLM | Azure AI Foundry, GPT-5, streaming, prompt caching |
| LLM auth | API key from `.env` (not all users have AAD access assigned) |
| Work item source (phase 1) | Azure DevOps Boards, `azure-devops` SDK + Azure DevOps MCP for LLM tools |
| ADO auth | `az login` passthrough |
| Hierarchy | Epic → Feature → User Story → Task/Bug |
| Cache | SQLite, single file, separate tables for cache and conversations |
| Cache refresh | Incremental via `System.ChangedDate` watermark |
| Cache scope | Configured on first launch, reconfigurable |
| Offline | Fail fast if ADO unreachable |
| Description format | Always Markdown; fallback on HTML-only projects |
| Conversation threading | Continuous per ticket; "new thread" keybind archives current |
| Attachment versioning | `convo-001.md`, `convo-002.md`, … |
| Mutations | Diff-preview-then-confirm for **all** writes (incl. agent tool-calls); dry-run mode available |
| TUI | Textual, three-pane |
| HTTP | FastAPI day 1, REST + SSE, static bearer, can be disabled |
| Telemetry | On by default, local-only, under `$XDG_CACHE_HOME/docket/` |
| Provider abstraction | First-class — `WorkItemProvider` interface, canonical model, named intents |
