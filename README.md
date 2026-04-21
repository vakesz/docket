# Docket

Docket is a terminal-first work-item triage app. It gives you a fast local cache, a three-pane Textual UI, and an assistant that can help refine tickets without bypassing review.

Every write still goes through a visible confirm step before anything is sent back to the provider.

## What It Does

- Browse work items in a clean backlog/detail/assistant layout.
- Filter the cache instantly by title, description, and comments.
- Chat about the selected item with prompt templates that are editable from inside the app.
- Stage transitions, description updates, and new work items through the same safe review flow.
- Edit `config.toml` settings from the app instead of hand-editing files.
- Switch themes, saved views, and prompt templates without leaving the TUI.

## Providers

Docket is built around a provider model for Azure DevOps and GitHub-style workflows.

- Azure DevOps is the fully wired provider in this repo today.
- GitHub support is part of the planned provider path captured in [plan.md](plan.md) and the provider abstraction already includes the GitHub reference shape used by the tests and docs.

## How It Works

1. Run setup and point Docket at the work you care about.
2. Sync a scoped slice of items into the local SQLite cache.
3. Open the TUI and move between backlog, detail, and assistant panes.
4. Review any proposed change before Docket applies it.

## Quick Start

```bash
uv sync
uv run docket setup
uv run docket
```

Useful commands:

```bash
docket                 # open the TUI
docket help            # command list + aliases
docket sync            # refresh the cache
docket ls              # list cached items
docket show S-42       # inspect one item
docket new task --title "Follow up"
docket serve           # run the local HTTP API
```

Inside the app:

- `?` help
- `,` settings
- `p` prompt library
- `/` filter
- `:` quick-open
- `Ctrl+P` command palette

## Setup

Use the [First-Time Setup Guide](FIRST_TIME_SETUP.md) for the shortest path from clone to working app.

## Development

```bash
uv sync
uv run pytest
uv run ruff check .
uv run mypy src
```

## Docs

- [FIRST_TIME_SETUP.md](FIRST_TIME_SETUP.md) — install and first-run setup
- [ADDING_A_PROVIDER.md](ADDING_A_PROVIDER.md) — provider integration guide
- [plan.md](plan.md) — architecture and milestone source of truth
