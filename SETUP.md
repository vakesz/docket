# First-time setup guide

This walks through getting `docket` running end-to-end. The interactive wizard (`docket setup`, or the automatic first-launch flow) does most of it — this guide explains what each step needs, what it writes, and how to recover if a step fails.

## Prerequisites

- **Python ≥ 3.12** and [`uv`](https://docs.astral.sh/uv/) (or `pipx` for the installed release).
- **Azure CLI** (`az`) installed and logged in (`az login`). The tool reuses your existing Azure session — it does not store Azure credentials itself.
- **Azure DevOps access** to at least one project, with permission to read work items and — once you start using mutations — edit them.
- **Azure AI Foundry** deployment URL, a deployed **GPT-5** model, and an API key. The CLI does not require AAD access to Foundry; it uses the key directly.
- **Terminal that supports true color** (iTerm2, modern GNOME Terminal, Windows Terminal, WezTerm, etc.) for the Textual TUI.

## Install

Two options:

**From a release (once published):**

```bash
pipx install docket
```

**From source:**

```bash
git clone <this-repo> docket
cd docket
uv sync
uv run docket
```

## Run the wizard

On first launch, `docket` detects the missing config and starts the wizard automatically. You can re-enter it any time via:

```bash
docket setup                    # full flow
docket setup --step=foundry     # jump to a specific step
```

Config is written atomically — a partial run leaves no half-formed config behind.

## What the wizard does, step by step

### 1. Azure CLI check

Runs `az account show`. If you're not logged in, it pauses and tells you to run `az login` in another terminal, then press Enter to retry.

Writes nothing. Failure here usually means `az` is not installed or not on PATH.

### 2. Azure DevOps connection

Prompts for:

- **Organization URL** (e.g. `https://dev.azure.com/your-org`)
- **Project name**

The wizard calls `list_projects` to confirm the connection works and resolves the project ID.

Recovery: if the call fails, check that your `az` session has access to the org. A `403` usually means you need to be added to the project.

### 3. Scope filters

Work-item boards can be huge. The wizard prompts for filters so the cache only holds items you care about:

- **Team** (optional)
- **Area path** (optional, supports the `Project\Area` prefix tree)
- **Iteration path** (optional; defaults to "current iteration")
- **Assignee** (default: you; or "anyone")

After each choice the wizard shows the matching item count so you can judge whether your filter is right. You can redo this step until you're happy.

Scope lives in `config.toml` as a named scope; you can edit or add alternate scopes later with `docket config scopes`.

### 4. Work item type & state probing

The wizard probes your ADO process template to build the canonical ↔ provider state map:

- What states does each work item type support?
- Is `System.Description` Markdown-capable or HTML-only?

The result is persisted so state transitions and description writes always land in the right shape. On HTML-only projects you'll see a warning — the provider transparently falls back to an HTML↔Markdown converter and flags the fact in `sync_state`.

Nothing to do here interactively unless the probe fails.

### 5. Foundry setup

Prompts for:

- **Foundry endpoint URL** (e.g. `https://your-foundry.openai.azure.com/`)
- **Deployment name** for the GPT-5 model
- **API key**

The wizard offers to write the API key to `$XDG_CONFIG_HOME/docket/.env` (default `~/.config/docket/.env`). You can decline and provide the key via another env source — the loader looks at env vars first, then the `.env` file.

A small test call is made to confirm the deployment works. A 401 means the key is wrong; a 404 usually means the deployment name is off.

### 6. HTTP surface

The FastAPI server gives you REST + SSE over the same service layer that drives the CLI and TUI. You can:

- **Enable it** — the wizard generates a random bearer token, shows it once, and writes it to `config.toml`. Bind address defaults to `127.0.0.1:8765`.
- **Disable it** — skip entirely. You can turn it on later with `docket config http enable`.

If enabled, run the server with `docket serve`. Calls require `Authorization: Bearer <token>`.

### 7. Telemetry

Usage/performance/cost logs are **on by default** and written to `$XDG_CACHE_HOME/docket/logs/` (default `~/.cache/docket/logs/`). Everything is local — nothing is shipped anywhere. Opt out with `docket config telemetry disable`.

The token/cost ledger (per conversation) is also stored under the cache dir and surfaces in the TUI footer.

### 8. Prompt templates

The wizard scaffolds editable Markdown templates per item kind in `$XDG_CONFIG_HOME/docket/prompts/`:

- `epic.md`
- `feature.md`
- `story.md`
- `task.md`
- `bug.md`

These are the agent's "persona" per item type. Edit any of them freely; the next conversation picks up the change. Delete one to revert to the built-in default.

### 9. Database init and initial sync

Creates the SQLite database at `$XDG_STATE_HOME/docket/docket.db` (default `~/.local/state/docket/docket.db`), runs migrations, then performs the initial full sync of your scope. The wizard shows the count of items synced.

If the sync is interrupted, run `docket sync` to resume — it's incremental from the watermark.

### 10. Smoke test

A final end-to-end dry run: pick the first item in your scope, open the agent, receive a greeting, close without writes. Proves the whole pipeline is wired correctly.

## Files the wizard writes

| Path | Contents |
| --- | --- |
| `$XDG_CONFIG_HOME/docket/config.toml` | ADO org/project, scopes, HTTP toggle & token, telemetry toggle, model settings |
| `$XDG_CONFIG_HOME/docket/.env` | `AZURE_OPENAI_API_KEY` (if you agreed to store it here) |
| `$XDG_CONFIG_HOME/docket/prompts/*.md` | Editable per-kind agent prompts |
| `$XDG_STATE_HOME/docket/docket.db` | SQLite cache, conversations, sync state |
| `$XDG_CACHE_HOME/docket/logs/*.jsonl` | Structured local logs (rotating) |
| `$XDG_CACHE_HOME/docket/ledger.jsonl` | Token/cost entries |

On Linux these use the real XDG variables if set. On macOS they default under `~/Library/Application Support/`, `~/Library/Caches/`, and `~/Library/Application Support/` respectively unless you export the XDG vars explicitly — set them in your shell rc if you prefer the Linux-style paths.

## After setup

Everyday commands:

```bash
docket              # TUI (most common)
docket sync         # incremental refresh
docket list         # list items in scope
docket show <id>    # item detail
docket new          # create a new item
docket transition <id> <intent> --dry-run
docket patch <id> --from-file=desc.md --dry-run
docket serve        # start HTTP surface (if enabled)
```

Every mutating command accepts `--dry-run`. Every mutation in the TUI and over HTTP requires an explicit confirm step.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `az account show` fails during setup | Azure CLI not installed or session expired | Install `az`; run `az login` |
| `403` on ADO project fetch | You don't have access to that project | Add yourself or switch to a project you can read |
| Foundry test call returns `401` | API key wrong or expired | `docket setup --step=foundry` |
| Foundry test call returns `404` | Deployment name mismatch | `docket setup --step=foundry` |
| TUI renders colors wrong | Terminal not true-color | Use a true-color terminal or set `COLORTERM=truecolor` |
| Sync hangs on large scope | Filter too broad | Re-run step 3 with tighter area path / iteration |
| "Description format: HTML-only" warning | Project uses the older ADO process template | Nothing to do — the provider falls back to HTML↔MD conversion automatically |

Anything else — check `$XDG_CACHE_HOME/docket/logs/` for the most recent error trace.
