# Repo Map

## Top Level

- `src/docket/`: application package.
- `tests/`: pytest suite split into `unit/`, `integration/`, and `pilot/` trees, plus `fakes/` and `fixtures/` at the root.
- `.docs/`: architectural references (this tree); user-facing install/setup guide lives at `.docs/FIRST_TIME_SETUP.md`.
- `README.md`: product tour, provider contract, and developer quick start.
- `AGENTS.md`: repo-specific assistant guidance consumed by coding agents.
- `pyproject.toml`: package metadata, runtime and dev dependencies, Ruff, pytest, and mypy config.

## `src/docket/`

- `cli/`: Typer commands plus the Textual TUI.
- `api/`: FastAPI apps, route adapters, auth, deps, and runtime state.
- `agent/`: prompt assembly, tool registry, agent turn loop, Azure OpenAI client integration, transcript rendering, and `factory.build_agent` used by both surfaces.
- `core/`: canonical model types, proposal types, acceptance extraction, redaction, and workflow services.
- `providers/`: provider protocol, registry, and concrete Azure DevOps, GitHub, and stub adapters.
- `storage/`: SQLite connection setup, cache-schema reset logic, and repo helpers.
- `config/`: XDG paths, env loading, config schema, config persistence, prompt template scaffolding, interactive setup wizard.
- `telemetry/`: logging bootstrap.

## Placement Rules

- Put canonical domain types in `src/docket/core/model.py` and `src/docket/core/mutation.py`.
- Put provider-neutral workflows in `src/docket/core/services/`.
- Put remote tracker specifics in provider packages under `src/docket/providers/`, such as `src/docket/providers/azure_devops/` and `src/docket/providers/github/`.
- Put SQLite schema changes in `src/docket/storage/schema/` and row access in `src/docket/storage/repos/`.
- Put CLI/TUI-only concerns in `src/docket/cli/`; put HTTP-only translation in `src/docket/api/`.
- Put file-path, `.env`, and config serialization logic in `src/docket/config/`.

## Standard Shape

- Service-oriented domain work usually follows `surface -> core/service -> provider/repo`.
- Provider packages usually follow `provider.py`, `state_map.py`, and optional `auth.py` or `discover.py`.
- Route modules are thin adapters under `src/docket/api/routes/`, with dependencies resolved from `src/docket/api/deps.py`.
- TUI widgets live under `src/docket/cli/tui/widgets/`, while `src/docket/cli/tui/app.py` owns app-level composition and action wiring.

## Non-Standard Areas

- `src/docket/api/bootstrap_app.py` is a second FastAPI entrypoint used only when `config.toml` is missing.
- `src/docket/config/setup_wizard.py` is a large interactive onboarding module that currently mixes config work with provider-specific discovery.
- `src/docket/cli/tui/app.py` is an oversized orchestration hub; new work should prefer helpers or services before adding more responsibilities there.

## Ownership Boundaries

- `core/`, `storage/`, `agent/`, and `api/` are provider-neutral by design.
- `providers/` owns native field names, native state strings, and remote API quirks.
- `storage/` owns the SQLite schema and row shape.
- `config/` owns file locations and serialization, but setup/provider onboarding is a current hotspot called out in [Exception Audit](exception-audit.md).
