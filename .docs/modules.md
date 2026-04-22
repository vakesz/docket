# Modules

## `src/docket/cli/`

- Owns Typer command parsing, the Textual app, widgets, and TUI-only interaction details.
- Should delegate provider writes to `core/services/mutation_service.py` and chat turns to `core/services/conversation_service.py`.
- May wire concrete providers indirectly through `cli/context.py` and the provider registry.
- Prefer adding helper classes or services before adding more orchestration to `src/docket/cli/tui/app.py`.

Validated exception:

- `src/docket/cli/tui/app.py`: this file currently owns agent-runtime assembly, background sync scheduling, external-update polling, provider/scope switching, and mutation modal orchestration. It is intentional and covered by pilot tests, but it is larger than the target architecture wants.

## `src/docket/api/`

- Owns FastAPI app factories, route adapters, auth, dependency accessors, and HTTP-only runtime state.
- Should stay provider-neutral and talk through `WorkItemProvider`, `RuntimeState`, services, and repos.
- Bootstrapping without config is handled by `src/docket/api/bootstrap_app.py`, not by special cases sprinkled across routes.
- Route modules should not grow their own business workflows when a service can own them once.

Validated exception:

- `src/docket/api/app.py` currently assembles the agent runtime directly, duplicating logic already present in the TUI app. This is tested and stable today, but it should eventually move behind a shared factory.

## `src/docket/core/` and `src/docket/agent/`

- `core/` owns canonical types, proposal semantics, and provider-neutral services.
- `agent/` owns prompt assembly, tool schemas, the LLM loop, and transcript rendering.
- These layers must not import concrete providers directly.
- When a workflow spans chat plus persistence, prefer `conversation_service` or a sibling service instead of growing surface code.

## `src/docket/providers/`

- Owns the `WorkItemProvider` protocol, provider registry, and concrete provider adapters.
- Provider packages own native field names, state maps, auth helpers, and discovery logic.
- Optional provider-specific capabilities should be exposed by method presence and discovered at runtime.
- New providers should start from `src/docket/providers/github_stub/` because the stub encodes the canonical contract with minimal noise.

## `src/docket/storage/`

- Owns SQLite connection policy, destructive schema-reset rules, and repositories.
- Schema changes belong in `src/docket/storage/schema.py`; bump the cache schema version and let `init_db(...)` rebuild incompatible caches instead of adding migrations.
- Repo helpers should carry row-shape knowledge so surfaces and services do not write ad hoc SQL unless there is a clear, narrow reason.
- FTS behavior and watchlist semantics are storage concerns, not TUI concerns.

## `src/docket/config/`

- Owns config schemas, XDG path resolution, `.env` precedence, atomic config persistence, and prompt-template file scaffolding.
- The long-term target is for this package to remain file/schema oriented, with less workflow logic embedded directly inside it.
- Setup currently spans both an interactive CLI wizard and an HTTP bootstrap flow.

Validated exception:

- `src/docket/config/setup_wizard.py`: imports concrete Azure DevOps and GitHub discovery code, performs provider-specific prompting, scaffolds prompts, writes config, and runs initial sync. It is intentional and tested, but it breaks the cleaner “config primitives only” boundary and duplicates parts of the HTTP setup flow.

## Before Adding a New Exception

- First ask whether the work belongs in a shared service, helper, or factory instead of a surface adapter.
- If the change must violate a boundary temporarily, add it to [Exception Audit](exception-audit.md) with the file path and the normalization path.
- Prefer one well-named seam over repeating the same workaround in both TUI and API surfaces.
