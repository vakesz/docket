# First-Time Setup

A friendly walkthrough from a clean clone to a working Docket install, covering Azure DevOps and GitHub. Follow this top-to-bottom the first time; skim-read it on upgrades.

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Run the setup wizard](#run-the-setup-wizard)
- [Provider walkthroughs](#provider-walkthroughs)
  - [Azure DevOps](#azure-devops)
  - [GitHub](#github)
  - [github_stub (demo / tests)](#github_stub-demo--tests)
- [Wire up the LLM (Azure OpenAI)](#wire-up-the-llm-azure-openai)
- [Run the HTTP API and web UI](#run-the-http-api-and-web-ui)
- [Optional: add more providers later](#optional-add-more-providers-later)
- [Files Docket creates](#files-docket-creates)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| Python 3.12+ | Backend runtime | [python.org](https://www.python.org/) or `pyenv` |
| [`uv`](https://docs.astral.sh/uv/) | Packaging + venv manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| [Bun](https://bun.com) (only for the web UI) | Frontend runtime + package manager | `curl -fsSL https://bun.sh/install \| bash` |
| A true-color terminal | The TUI leans on theme colors | iTerm2, Alacritty, WezTerm, Ghostty, Windows Terminal |
| Provider credentials | See the per-provider sections below | — |
| Azure OpenAI deployment | For chat / suggestions | Endpoint + deployment name + API key |

You can skip the LLM entirely — Docket launches without it, you just lose chat. Pass `--no-chat` to `docket open` (or `docket serve`) to silence the "chat disabled" toast.

---

## Install

```bash
git clone <repo-url> docket
cd docket
uv sync
```

`uv sync` creates a venv, installs the runtime deps and the dev extras, and leaves you ready to run `uv run docket …`. No global `pip install` needed.

For the web UI, also install the frontend deps (or use `make install` to do both):

```bash
make install      # uv sync + (cd frontend && bun install)
```

Verify:

```bash
uv run docket help
```

You should see the command table. If not, jump to [Troubleshooting](#troubleshooting).

---

## Run the setup wizard

```bash
uv run docket setup
```

The wizard is idempotent — re-running it overwrites only the fields you confirm. You can also resume at a specific step:

```bash
uv run docket setup --step=llm     # only re-run the LLM step
```

Step names, in order: `provider` · `auth` · `connection` · `label` · `scope` · `telemetry` · `http` · `llm` · `prompts` · `sync` · `default`. The `label` step prompts for the human-readable display name shown in the TUI/web provider switcher.

The top-level wizard:

1. Discovers providers already in `config.toml` and lets you reconfigure or add more.
2. Walks the per-provider auth + connection + scope flow for the selected backend.
3. Runs the shared host steps:
   - **telemetry** — keep the rotating JSON log on (default), pick a level
   - **http** — enable the FastAPI surface and mint a bearer token (consumed by the web UI and any external clients)
   - **llm** — Azure OpenAI endpoint + deployment, persisted to `config.toml`; the API key still lives in `.env`
   - **prompts** — scaffold `system_base.md` + `kind_<kind>.md`
   - **sync** — first full sync from the active provider
   - **default** — pin this provider as the active one if it's the first or you opt in

---

## Provider walkthroughs

### Azure DevOps

#### Prereqs

```bash
az login                          # interactive sign-in
az account show                   # sanity check
```

The wizard shells out to `az` for token acquisition — it won't prompt you for a PAT.

#### Wizard questions

1. **Organization URL** — `https://dev.azure.com/<org>`. Auto-discovered from your `az` session when possible; falls back to free-form prompt.
2. **Project name** — picker from the org's projects, or free-form when discovery is blocked.
3. **Scope filter** — defaults to "any" on team / area path / iteration path / assignee. Each axis is optional and shows a count of matching items before you confirm.

#### What it does under the hood

- Saves `providers.<key>.config = { organization, project }` and a `default` scope to `config.toml`.
- Probes the project with `health_check()` before continuing.
- Counts items matching the selected scope so an over-narrow filter is obvious.

#### Notes

- If your project uses HTML-only description fields, Docket detects this on first sync and flips a flag in `sync_state` so Markdown ↔ HTML conversion happens transparently.
- Canonical states are translated in `providers/azure_devops/state_map.py`. If a custom state isn't mapped cleanly, add it there — the rest of the app deals in canonical `ItemState` only.

---

### GitHub

#### GitHub prereqs

```bash
gh auth login                     # recommended — uses your existing gh session
gh auth status                    # confirm the active account
```

Docket reads `gh auth token` at startup and falls back to the `GITHUB_TOKEN` environment variable if `gh` isn't installed. No PAT prompt during setup.

#### GitHub wizard questions

1. **Repo picker** — Docket scans `/user/repos` for repos you own or collaborate on, plus every org you're a member of via `/orgs/{org}/repos` (this is deliberate — `/users/{login}/repos` would miss private repos you have access to). Pick one from the list.
2. If nothing comes back (no `gh`, no orgs, no accessible repos), the wizard drops to a manual `owner/name` prompt.
3. **Scope filter** — GitHub's query params only honor `assignee`, so team / area / iteration options are hidden. `@me` expands to the authenticated user; pick `any` for everything in the repo.

#### What GitHub setup does under the hood

- Saves `providers.<key>.config = { default_repo: "owner/name" }`.
- Issues + PRs both map to the canonical `Item`. Label-based kind guessing: `bug` → BUG; `enhancement|feature|story` → STORY; `epic` → EPIC; default → TASK. PRs are always TASK.
- Canonical id format is `owner/name#number` — stable across syncs.

#### Tips

- The agent tool `find_related_prs` registers itself automatically for GitHub — ask the assistant "any PRs that might close this?" and it'll scan the repo's recent PRs.
- GitHub REST has no direct attachment upload, so `upload_attachment` raises a descriptive `ProviderUnreachableError`. The workaround Docket expects is posting a comment with an externally-hosted URL.

---

### github_stub (demo / tests)

In-memory reference provider, registered in the wizard as **"GitHub (in-memory)"**. Zero auth, zero network. Useful when:

- You want to poke at the TUI without wiring a real backend.
- You're developing a new feature and want determinism.
- You're writing a test and need something that satisfies the `WorkItemProvider` Protocol.

```bash
uv run docket setup provider add demo --type github_stub --display-name "Demo"
```

The wizard will ask for a `default_repo` (any `owner/name` string works — it's just a label).

---

## Wire up the LLM (Azure OpenAI)

The wizard's `llm` step writes the **endpoint** and **deployment** into `config.toml` under `[llm]`. The **API key** has no `config.toml` home and stays in `.env`. At runtime the env vars below override `config.toml`, so you can keep all four LLM values in `.env` if you prefer.

| Variable | Purpose |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Deployment base URL (`https://<resource>.openai.azure.com/`) |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (the GPT-5 / equivalent model) |
| `AZURE_OPENAI_API_KEY` | API key (`.env` only) |
| `AZURE_OPENAI_API_VERSION` | Optional; defaults to the latest published version |

`.env` resolution order (first hit wins):

1. Repo-local `.env` (walking up from CWD)
2. User-level `.env` under the docket config dir (`~/Library/Application Support/docket/.env` on macOS, `~/.config/docket/.env` on Linux)

Both are gitignored.

You can skip the LLM entirely. The TUI launches without chat; `docket open --no-chat` (or `docket serve --no-chat`) silences the warning if you want it quiet. `/conversation` HTTP endpoints return 503 until an endpoint is configured.

### Prompt templates

Docket scaffolds `system_base.md` and `kind_<kind>.md` under `prompts/`. Edit them at any time — the loader keeps an mtime cache, so saved changes take effect on the next turn without restarting the app. The in-app Prompt Library (`p`) opens an editor backed by the same files.

The prompt prefix `[system + kind template] → [ticket snapshot] → ---` is byte-stable on purpose so Azure OpenAI prompt caching hits on every follow-up turn. Don't interpolate timestamps or scope into the prefix; those go after the `---` divider.

---

## Run the HTTP API and web UI

The wizard's `http` step enables the FastAPI surface and mints a bearer token into `config.toml` under `[http]`. After setup:

```bash
uv run docket serve         # listens on http://127.0.0.1:8765, bearer required
```

`docket serve` refuses to start when `[http] enabled = false` or `[http] token` is empty — re-run `docket setup --step=http` to fix either.

`--read-only` and `--no-chat` apply to `serve` the same way they do to `open`. `DOCKET_LOG_LEVEL` (`critical` … `debug` / `trace`) controls uvicorn's verbosity.

### Bootstrap mode

Before `config.toml` exists, `docket serve` falls through to a tiny FastAPI exposing only `/health` and `/setup/*`, gated by `DOCKET_SETUP_TOKEN`. If you don't set it, one is generated and printed for the session — useful for driving the web UI through the wizard end-to-end.

### Web UI

```bash
make install         # uv sync + bun install (one-time)
make env             # mint a fresh DOCKET_API_TOKEN into .env (one-time, dev only)
make dev             # backend + vite dev server together
```

`make dev` brings up the backend on `127.0.0.1:8765` and the dev frontend on `localhost:3000`. The frontend's Bun server proxies `/api/*` to the backend with the bearer attached server-side; the token never reaches the browser.

`resolve-backend-config.ts` reads the token in this order:

1. `DOCKET_API_TOKEN` from the process env / repo-root `.env`
2. `[http] token` in `config.toml`

So once setup has written `config.toml`, you can clear `DOCKET_API_TOKEN` from `.env` and both stacks still agree on the same token. Override `DOCKET_API_URL` only when the backend isn't on `127.0.0.1:8765`.

Production: `make frontend-build` then `make frontend-start` runs the SSR bundle through Bun.

Regenerate the OpenAPI-typed client with `make gen-api` while the backend is running.

---

## Optional: add more providers later

You don't have to commit to one provider forever. Add another at any time:

```bash
# List what's configured
uv run docket setup provider list

# Add an extra provider (answer the wizard's prompts)
uv run docket setup provider add work-ado --type azure_devops
uv run docket setup provider add personal-gh --type github

# Make one the default
uv run docket setup provider add personal-gh --type github --active

# Drop one
uv run docket setup provider remove personal-gh
```

Inside the TUI, the command palette (`Ctrl+P`) has a **Switch provider** entry — the tree, scope, status bar, MCP fleet, and agent tool registry all rebind to the new active provider without restarting.

Third-party providers can ship as separate pip packages via the `docket.providers` entry-point group. The Protocol contract and cross-cutting test expectations are documented in the [README's "Providers" section](../README.md#providers).

---

## Files Docket creates

Resolved via `platformdirs` → XDG on Linux, Application Support on macOS, `%APPDATA%` on Windows. Every entry point honors `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` overrides on every platform — that's how the `.docket-dev/` redirect in `.env.example` keeps dev state out of your Library.

| Path (macOS shown) | Purpose |
| --- | --- |
| `~/Library/Application Support/docket/config.toml` | Providers, scopes, projects, LLM settings, HTTP token, UI preferences |
| `~/Library/Application Support/docket/.env` | Azure OpenAI key + optional provider secrets |
| `~/Library/Application Support/docket/prompts/system_base.md` | System prompt, editable from the app |
| `~/Library/Application Support/docket/prompts/kind_<kind>.md` | Per-kind prompt (one per `ItemKind`) |
| `~/Library/Application Support/docket/docket.db` | SQLite cache (items, comments, conversations, messages, watchlist, memory, sources, FTS5) |
| `~/Library/Caches/docket/logs/docket.log` | Structlog rotating JSON log (1 MB × 3) |
| `~/Library/Caches/docket/ledger.jsonl` | Per-turn token / cost ledger |

The SQLite cache keeps a `PRAGMA user_version`, but Docket intentionally supports
one cache schema at a time right now. If the on-disk schema is older, startup
drops the cached tables and re-pulls items instead of running migrations.

`docket status` prints all of these (with sizes) plus cache row counts, sync watermarks, MCP fleet for the active project, telemetry config, and HTTP state. Add `-v` for the last few tool / proposal / MCP events from the log.

---

## Troubleshooting

### `docket` prints "Provider '…' is not configured"

Re-run `uv run docket setup` to step through provider configuration again. If you've clean-checked out a newer version and the old `config.toml` is incompatible, the wizard will detect this and ask before overwriting.

### Azure auth fails during setup

```bash
az account show                                   # verify a live session
az login                                          # re-authenticate if needed
az account set --subscription <id-or-name>        # if you have multiple subscriptions
```

Re-run `docket setup --step=auth` (or `--step=connection` if you only need to re-pick the org/project).

### GitHub setup shows no repos

- Confirm `gh auth status` — the CLI must be signed in as the account you want to triage under.
- Check `gh api user --jq .login` — if this errors, your token lacks `read:user` scope. Run `gh auth refresh -s read:user,read:org,repo`.
- If you only want public repos, any `GITHUB_TOKEN` with `public_repo` scope works — set it in `.env` and skip the `gh` step.

### "Chat disabled: set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT …"

The TUI / API didn't find Azure OpenAI credentials. Either:

- Run `docket setup --step=llm` to persist the endpoint + deployment into `config.toml` and add `AZURE_OPENAI_API_KEY` to your `.env`, or
- Set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, and `AZURE_OPENAI_API_KEY` in `.env` directly (env vars override `config.toml`), or
- Launch with `docket open --no-chat` / `docket serve --no-chat` to silence the warning entirely.

### `docket serve` exits with "HTTP surface is disabled" or "No bearer token configured"

The `[http]` section in `config.toml` either has `enabled = false` or `token = ""`. Re-run `docket setup --step=http` — it generates a fresh `secrets.token_urlsafe(32)` and writes it back. Or set `DOCKET_API_TOKEN` in `.env` and re-run the step (the wizard will mirror it into `config.toml`).

### Web UI loads but every `/api/*` request 401s

Either `DOCKET_API_TOKEN` (in `.env`) and `[http] token` (in `config.toml`) disagree, or both are empty. `make env` mints a fresh token into `.env`; the wizard mirrors `DOCKET_API_TOKEN` from the env into `config.toml` if it's set when you run `docket setup --step=http`. After they agree, restart `make dev` so the Bun proxy picks up the new value.

### "Read-only mode — mutations disabled"

Either you passed `--read-only` or `DOCKET_READ_ONLY=1` is set in your environment. Unset it and relaunch. The status bar shows a `READ-ONLY` badge while the flag is active so this shouldn't sneak up on you.

### The tree is empty after sync

- `docket sync` to force a pull, or `docket sync --full` to ignore the watermark.
- Confirm your scope filter returns anything with the provider's native UI. Use the in-app settings (`,`) to widen the scope, or re-run `docket setup --step=scope`.
- Check the log file (`docket status` shows the path) for provider errors.

### The TUI feels cramped

- `Ctrl+F` maximizes the focused pane; `Ctrl+F` again restores the three-pane layout.
- `Ctrl+Left` / `Ctrl+Right` resize panes by 5% each press.
- Pick a denser theme with `Ctrl+T` — preview on highlight, commit on Enter, revert on Esc.

### Something else

- `docket setup` is always safe to re-run (whole wizard or a single `--step=`).
- `docket status` (`-v` for recent events) is the fastest health check — it shows paths, cache counts, sync state, MCP fleet, telemetry, and HTTP state in one screen.
- Open the in-app settings with `,` to fix saved values without touching `config.toml` by hand.

Still stuck? `tests/` has worked examples for every feature — the TUI pilot tests (`tests/pilot/test_tui_*.py`) double as behavioural documentation for "this is how feature X is expected to behave."
