# Config and Setup

- XDG path resolution and `.env` precedence are central to how Docket boots.
- Config writes are atomic; keep that property.
- Prompt templates use canonical filenames and hot-reload through the agent prompt loader.
- There are two setup adapters today: the interactive CLI wizard and the HTTP bootstrap setup surface.
- The current setup implementation is a documented exception area; prefer shared services over more duplication.
- Related docs: [Architecture](../architecture.md), [Exception Audit](../exception-audit.md), [HTTP Surfaces](http-surfaces.md)

## Architecture Overview

```text
repo-local .env -> resolve_paths() -> XDG config/state/cache
                                  |
                                  +--> load_config / save_config
                                  +--> prompt_templates scaffold/read/write/reset
                                  +--> setup_wizard (CLI)
                                  +--> /setup/* routes (HTTP bootstrap)
```

## Ownership Boundaries

- `src/docket/config/paths.py` owns XDG path resolution.
- `src/docket/config/env.py` owns repo-local and XDG `.env` loading plus env accessors.
- `src/docket/config/loader.py` owns atomic config persistence.
- `src/docket/config/prompt_templates.py` owns prompt template metadata and file scaffolding.
- `src/docket/config/setup_wizard.py` and `src/docket/api/routes/setup.py` currently own setup adapters.

## Core Rules

- Load repo-local `.env` before resolving paths so repo-specific XDG overrides win over the shell (`src/docket/config/env.py`, `src/docket/cli/context.py`).
- Load the XDG `.env` afterward without overriding existing process env (`src/docket/config/env.py`).
- Persist config atomically through `save_config(...)`; do not write `config.toml` by hand from multiple surfaces (`src/docket/config/loader.py`).
- Keep prompt files under the canonical names defined by the template registry while still honoring legacy per-kind filenames (`src/docket/config/prompt_templates.py`, `src/docket/agent/prompt.py`).
- Treat setup as an onboarding workflow, not just config serialization: it may scaffold prompts, generate tokens, and optionally run initial sync (`src/docket/config/setup_wizard.py`, `src/docket/api/routes/setup.py`).

## Non-Obvious Patterns

- `docket serve` drops into bootstrap mode when config is missing, generating a setup token if one is not supplied.
- The HTTP setup flow can run later on a fully configured app because setup routes are mounted there too.
- Prompt-library edits apply on the next assistant turn through the prompt loader’s mtime cache; no restart is required.
- Config and prompt writes are currently spread across widgets and route modules; that is real duplication and should not be copied blindly.

## Common Scenarios

### Add a new config field

- Add it to the Pydantic model in `src/docket/config/models.py`.
- Update any setup entrypoints that need to populate it.
- Decide whether changing it requires restart and keep the API response honest.

### Add a provider-specific setup field

- Today you must update both `src/docket/config/setup_wizard.py` and `src/docket/api/routes/setup.py`.
- Treat that as temporary debt and note the duplication in the exception audit if the change increases it.

## Validation Checklist

- [ ] `uv run pytest tests/test_config.py tests/test_setup_wizard.py`
- [ ] `uv run pytest tests/test_api_setup.py tests/test_prompt_loader.py`
- [ ] `uv run pytest tests/test_cli_root_defaults.py tests/test_cli_help.py`
