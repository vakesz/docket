# Architecture

## Core Principles

- Preserve provider neutrality outside the provider layer. The canonical app talks to `WorkItemProvider`, not Azure DevOps or GitHub classes.
- Keep every provider write proposal-first and confirmation-gated.
- Treat SQLite as a local cache and transcript store, not the source of truth for work items.
- Optimize chat for stability: cache-stable prompt prefix, deterministic tool order, and explicit compaction.
- Prefer explicit runtime injection over global state.

## Data Flow

```text
Typer CLI / Textual TUI / FastAPI
             |
             v
     prepare() / prepare_or_wizard()
  paths + env + config + db + providers
             |
             +--> TUI actions --------------------------+
             |                                          |
             |                                          v
             |                               core/services + agent
             |                         sync / mutation / conversation
             |                                          |
             +--> API routes + deps/runtime ------------+
                                                        |
                                                        +--> storage/repos + schema
                                                        |
                                                        +--> providers/base -> providers/*
```

Forbidden edges:

- `core/`, `storage/`, `agent/`, and `api/` -> concrete provider packages.
- Surface adapters -> provider write methods.
- Prompt prefix -> dynamic scope/time/user data before the cache boundary.

## Current Layers

### Surface Adapters

- Command modules under `src/docket/cli/commands/` parse command-line input and delegate to services or the TUI.
- `src/docket/cli/tui/` renders the three-pane app and binds actions to services.
- Route modules under `src/docket/api/routes/` translate HTTP requests into service calls and DTOs.

### Domain and Workflow Layer

- `src/docket/core/model.py` defines canonical work-item, conversation, and scope types.
- `src/docket/core/mutation.py` defines proposal types and diff rendering.
- `src/docket/core/services/` owns sync, mutation, conversation, compaction, suggestion, external-update, and proposal-queue workflows.
- `src/docket/agent/` owns prompt assembly, tool registration, the LLM loop, and transcript rendering.

### Adapter Layer

- `src/docket/providers/` owns remote API calls, native field/state translation, and provider registration.
- `src/docket/storage/` owns SQLite connection policy, destructive cache-schema reset logic, and repositories.
- `src/docket/config/` owns XDG paths, `.env` loading, config schema, prompt template files, and setup entrypoints.

## Mutation and Confirmation

- Every write becomes a `Proposal` first (`src/docket/core/mutation.py`).
- `src/docket/core/services/mutation_service.py` is the only place in `src/` that calls provider write methods.
- CLI commands confirm in-terminal, the TUI uses diff modals, the HTTP API uses propose/confirm endpoints, and agent tools queue proposals in `ProposalStore`.
- Read-only mode blocks the same mutation surface in all three adapters.

## Chat and Prompt Stability

- `src/docket/agent/prompt.py` builds a stable `[system + kind guidance] + [ticket snapshot]` prefix.
- `src/docket/agent/tools.py` keeps tool registration ordered because tool schema order affects prompt caching.
- `src/docket/core/services/conversation_service.py` compacts before building the next prompt when token usage crosses the configured threshold.
- `src/docket/core/services/external_update_service.py` injects provider-side changes back into active conversations to keep the assistant grounded.

## Storage and Caching

- `src/docket/storage/db.py` enables WAL and `check_same_thread=False` because the TUI and SSE chat path use worker threads.
- `src/docket/core/services/sync_service.py` reads by watermark and bulk-upserts cached items.
- `src/docket/storage/repos/search_repo.py` uses FTS5 for search and a separate OR query for duplicate detection.
- `src/docket/storage/schema.py` intentionally keeps watchlist rows independent from cached-item FK constraints.

## Setup and Runtime Switching

- `src/docket/cli/commands/serve.py` chooses between the full API and bootstrap setup API depending on whether config exists.
- `src/docket/api/runtime.py` owns session-scoped active provider and scope for the HTTP surface.
- `src/docket/config/setup_wizard.py` and `src/docket/api/routes/setup.py` both perform setup today, which is a real duplication hotspot.
- See [Config and Setup](playbooks/config-and-setup.md) and [Exception Audit](exception-audit.md) before extending either path.

## Target Architecture for New Work

- Keep surface modules thin: parse input, call one workflow service, map output.
- Consolidate shared workflows into services or factories before adding more logic to `src/docket/cli/tui/app.py`, `src/docket/config/setup_wizard.py`, or route modules.
- Move config writes, prompt-file edits, agent-runtime assembly, and provider onboarding toward shared services so TUI and API stop duplicating them.
- Treat `config/` as schemas, file paths, and serialization primitives; provider-specific setup logic should move toward provider metadata or dedicated onboarding services.
- When current code violates that target, document it in [Exception Audit](exception-audit.md) instead of silently normalizing the drift.
