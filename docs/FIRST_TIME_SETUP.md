# First-Time Setup Guide

This is the shortest path to a working Docket install.

## Before You Start

- Python 3.12+
- [`uv`](https://docs.astral.sh/uv/)
- A terminal with true-color support
- Azure DevOps access and an active `az login`
- Azure AI Foundry endpoint, deployment name, and API key
- GitHub auth follows the `gh` / `GITHUB_TOKEN` provider path described in [plan.md](plan.md)

GitHub is part of the provider direction described in [plan.md](plan.md). In this repo, the live setup path is Azure DevOps first.

## Install

```bash
git clone <repo-url> docket
cd docket
uv sync
```

## Run Setup

```bash
uv run docket setup
```

The setup flow will:

1. Check your Azure CLI session.
2. Ask for the Azure DevOps org and project.
3. Save a default scope filter.
4. Ask whether to keep local telemetry enabled.
5. Scaffold prompt templates.
6. Create the local database and run the first sync.

## Start Using The App

```bash
uv run docket
```

Helpful commands:

```bash
docket help
docket sync
docket ls
docket show <id>
docket serve
```

Helpful in-app shortcuts:

- `?` help
- `,` settings editor
- `p` prompt library
- `/` filter
- `:` quick-open
- `Ctrl+T` theme picker

## Files Docket Creates

- `config.toml` for saved settings
- `.env` for optional local secrets
- `prompts/system_base.md` and `prompts/kind_*.md` for editable prompt templates
- `docket.db` for the local cache
- local logs and usage ledger files under the cache directory

## If Something Goes Wrong

- Re-run setup with `docket setup`
- Open the in-app settings screen with `,` to fix saved values
- Check the local logs directory under Docket's cache path

If Azure auth is the issue, run `az login` first and then retry setup.
