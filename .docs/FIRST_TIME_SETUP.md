# First-Time Setup

A friendly walkthrough from a clean clone to a working Docket install, covering Azure DevOps and GitHub. Follow this top-to-bottom the first time; skim-read it on upgrades.

There are two front doors to the wizard — pick whichever fits how you work:

- **Web wizard** (`make serve` → browser at `http://127.0.0.1:8765`) — recommended for a first run on a development checkout. Same questions as the CLI, with click-to-select pickers for orgs/projects/repos and a live "→ N items match" scope preview.
- **CLI wizard** (`docket setup`) — works over SSH, no browser needed.

Both write the same `config.toml`. Either one is safe to re-run.

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Run the setup wizard](#run-the-setup-wizard)
  - [Web wizard (browser)](#web-wizard-browser)
  - [CLI wizard (terminal)](#cli-wizard-terminal)
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
uv run docket --help
```

You should see the command table. If not, jump to [Troubleshooting](#troubleshooting).

---

## Run the setup wizard

> **Use `make` targets for development.** Every `make` target runs `docket --workspace=./.docket-dev`, which redirects `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` / `XDG_DATA_HOME` under `./.docket-dev/{config,state,cache,data}/`. That keeps the SQLite cache, `config.toml`, prompts, rotating logs, and the bearer-token mint inside the repo dir instead of bloating your real `~/Library/Application Support/docket/` (macOS), `~/.config/docket/` + `~/.local/state/docket/` (Linux), or `%APPDATA%\docket\` (Windows). When you're done iterating, `make clean-workspace` deletes the entire sandbox in one shot.
>
> Plain `uv run docket setup` is fine for a daily-driver install — it just writes to the platform-default paths. Pass `--workspace=./somewhere/` if you want sandboxed state without going through Make.

### Web wizard (browser)

```bash
make install     # uv sync + bun install — one-time
make serve       # builds the SPA, mints a bootstrap token, opens at http://127.0.0.1:8765
```

The first invocation writes a stub `./.docket-dev/config.toml` containing only the freshly-minted `[http].token`, then starts FastAPI in **bootstrap mode**: only `/api/health`, `/api/setup/*`, and the SPA itself are mounted. Browse to `http://127.0.0.1:8765` and the wizard loads at `/`. The bearer is injected into `index.html` as `window.__DOCKET_TOKEN__` — no copy-paste, the page authenticates against the same origin.

The browser flow mirrors the CLI step-for-step:

1. **CLI status** — probes `gh` and `az` sessions on your local box. Each tool gets a card showing presence + sign-in state + identity. If something's missing or signed out, the card prints the install / `gh auth login` / `az login` command; fix it in another terminal and click **Refresh**.
2. **Provider** — combined pick + connection + label step. The picker only surfaces provider types whose `requires_cli` is satisfied (so e.g. Azure DevOps is hidden until `az` is signed in). For ADO the wizard offers an org / project picker driven by `/api/setup/azure-devops/discover` (with manual fallback when discovery fails); for GitHub it offers a repo / org-repo picker driven by `/api/setup/github/discover`. The display-name field auto-suggests via `/api/setup/suggest-label` until you start typing.
3. **Scope** — provider-specific filters with a **Preview match count** button that calls `/api/setup/probe-scope` and shows the same "→ N item(s) match this scope" preview the CLI prints.
4. **LLM** — Azure OpenAI endpoint, deployment, API version, optional cost-tracking prices (auto-filled for known deployments). The API key is round-tripped through a password field; on `Complete` the backend writes it to the OS keyring (Keychain / Credential Manager / Secret Service / kwallet). If no keyring backend is reachable, the page surfaces the same error the CLI raises and refuses to proceed.
5. **Settings** — telemetry on/off + log level, HTTP bind/port, "run initial sync" toggle.
6. **Review → Complete** — submits to `/api/setup/complete`, which writes `config.toml`, scaffolds prompt templates, and signals the server to exit so you can re-run `make serve` against the real config.

### CLI wizard (terminal)

```bash
uv run docket --workspace=./.docket-dev setup
```

The wizard is idempotent — re-running it overwrites only the fields you confirm. You can also resume at a specific step:

```bash
uv run docket --workspace=./.docket-dev setup --step=llm     # only re-run the LLM step
```

Step names, in order: `provider` · `auth` · `connection` · `label` · `scope` · `telemetry` · `http` · `llm` · `prompts` · `sync` · `default`. The `label` step prompts for the human-readable display name shown in the TUI/web provider switcher.

The top-level wizard:

1. Discovers providers already in `config.toml` and lets you reconfigure or add more.
2. Walks the per-provider auth + connection + scope flow for the selected backend.
3. Runs the shared host steps:
   - **telemetry** — keep the rotating JSON log on (default), pick a level
   - **http** — enable the FastAPI surface and mint a bearer token (consumed by the web UI and any external clients)
   - **llm** — Azure OpenAI endpoint + deployment, persisted to `config.toml`. The API key is stored in the OS keyring (macOS Keychain / Windows Credential Manager / freedesktop Secret Service); only a non-secret hint (`[llm.key_hint]` — first/last 4 characters, length, updated_at) lands in `config.toml` so the UI can preview it before you rotate.
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

The wizard's `llm` step writes the **endpoint** and **deployment** into `config.toml` under `[llm]`. The **API key** is stored in the OS keyring; nothing secret ever touches disk in plaintext.

| Field | Where it lives |
| --- | --- |
| Endpoint (`https://<resource>.openai.azure.com/…`) | `config.toml` → `[llm].endpoint` |
| Deployment name (the GPT-5 / equivalent model) | `config.toml` → `[llm].deployment` |
| API version (optional; defaults to the latest published) | `config.toml` → `[llm].api_version` |
| API key | OS keyring under service `docket`, account `azure_openai_api_key` |
| Non-secret key hint (`prefix`, `suffix`, `length`, `updated_at`) | `config.toml` → `[llm.key_hint]` (UI preview only) |

The keyring backend is platform-native: macOS Keychain, Windows Credential Manager, or freedesktop Secret Service on Linux. If no backend is available, the wizard's `llm` step refuses to continue with a clear error. There is no env-var override — the only way to set or rotate the key is through the wizard, the Settings UI, or `POST /api/settings/llm-key`.

To rotate or remove the key later:

- **Settings UI** (`,` in the TUI / web Settings → LLM): the form shows a `prefix…suffix · N chars · updated 2d ago` badge for the currently-stored key. Use the **Rotate** button to overwrite, **Remove** to clear.
- **HTTP**: `POST /api/settings/llm-key` (body `{"api_key": "…"}`) and `DELETE /api/settings/llm-key`. Both return `requires_restart: true` so the live `LlmClient` is rebuilt on the next boot.

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

`--read-only` and `--no-chat` apply to `serve` the same way they do to `open`. Both flags also have a config home: `runtime.read_only = true` and `telemetry.uvicorn_log_level = "debug"` (or `critical` … `debug` / `trace`) survive across launches without re-passing the flag. `docket serve --log-level=…` overrides for one run.

### Bootstrap mode

Before `config.toml` exists, `docket serve` falls through to a tiny FastAPI exposing only `/api/health`, `/api/setup/*`, and the SPA bundle at `/`. The first invocation mints a fresh bearer token, writes a stub `config.toml` containing only `[http].token`, and prints the token once. Reach the wizard at `http://127.0.0.1:8765` — the SPA loads in bootstrap mode, the bearer is injected as `window.__DOCKET_TOKEN__` so you don't have to copy-paste, and on **Complete** the server writes the real config and exits so you can re-run `make serve` (or `docket serve`) against it. Recover the token later with `make token` or `docket admin print-token`.

### Web UI

```bash
make install         # uv sync + bun install (one-time)
make serve           # build the SPA and run the backend serving it (mints a bootstrap token if config.toml is missing)
make token           # print the bearer token from the workspace config.toml
```

`make serve` runs `bun run build` (vite emits the static SPA into `src/docket/frontend_dist/`) and then starts the backend at `127.0.0.1:8765` — one process, one origin, no separate frontend server. The bearer token is injected into `index.html` at request time as `window.__DOCKET_TOKEN__` and re-attached to every API call from the browser. The token only ever lives on the local box — same trust model as the wheel install.

All `make` targets pass `--workspace=./.docket-dev` to `docket`, which redirects `XDG_CONFIG_HOME/STATE_HOME/CACHE_HOME/DATA_HOME` under that directory so dev state never lands in `~/Library/Application Support/docket/` or `~/.config/docket/`. `make clean-workspace` deletes the dev sandbox.

To iterate on the SPA, re-run `make frontend-build` and refresh the browser. There is no HMR loop; trade-off for the single-origin, single-process model.

`resolve-backend-config.ts` reads the token in this order:

1. `DOCKET_API_TOKEN` from the process env (CI / container override)
2. `[http] token` in `config.toml`

There is no `.env` walking — once setup has written `config.toml`, vite picks the token straight from there. Override `DOCKET_API_URL` only when the backend isn't on `127.0.0.1:8765`.

Production: `make serve` (or `make wheel` for the installable artifact). Both run `bun run build`, which emits the static SPA directly into `src/docket/frontend_dist/`; the backend then serves it from there.

Regenerate the OpenAPI-typed client with `cd frontend && bun run gen:api` while the backend is running.

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

Resolved via `platformdirs` → XDG on Linux, Application Support on macOS, `%APPDATA%` on Windows. Every entry point honors `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` overrides on every platform — that's how the `--workspace=./.docket-dev` flag (used by every `make` target) keeps dev state out of your Library.

| Path (macOS shown) | Purpose |
| --- | --- |
| `~/Library/Application Support/docket/config.toml` | Providers, scopes, projects, LLM settings (incl. `[llm.key_hint]` preview), HTTP token, runtime flags, UI preferences |
| OS keyring entry `docket / azure_openai_api_key` | Azure OpenAI key (managed via the wizard, the Settings UI, or `POST /api/settings/llm-key`) |
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
- If you only want public repos, any GitHub token with `public_repo` scope works — install `gh` and `gh auth login --with-token` to seed the session, then re-run setup.

### "Chat disabled: LLM is not configured"

The TUI / API didn't find Azure OpenAI credentials. Either:

- Run `docket setup --step=llm` to persist the endpoint + deployment into `config.toml` and store the API key in the OS keyring, or
- From the Settings UI's LLM section, paste the key into the **API key** field and click **Save**, or
- Launch with `docket open --no-chat` / `docket serve --no-chat` to silence the warning entirely.

If the wizard's `llm` step rejects the key with a keyring error, your platform doesn't have a usable backend (e.g. headless Linux without `gnome-keyring` / `kwallet`). Install one before continuing — Docket has no plaintext fallback by design.

### `docket serve` exits with "HTTP surface is disabled" or "No bearer token configured"

The `[http]` section in `config.toml` either has `enabled = false` or `token = ""`. Re-run `docket setup --step=http` — it generates a fresh `secrets.token_urlsafe(32)` and writes it back. If `config.toml` is missing entirely, `docket serve` mints a bootstrap token automatically and prints it once; recover it later with `docket admin print-token`.

### Web UI loads but every `/api/*` request 401s

The `[http] token` in `config.toml` is empty or has drifted from what the SPA fetched. Run `make token` (or `docket admin print-token`) to inspect the current token and re-run `make serve` so the value is injected into the served `index.html`. The frontend dev server reads the token from `config.toml` directly; there is no `.env` indirection to keep in sync.

### "Read-only mode — mutations disabled"

Either you passed `--read-only` on the command line or `runtime.read_only = true` in `config.toml`. Toggle the config entry from the Settings UI (or edit it manually) and relaunch. The status bar shows a `READ-ONLY` badge while the flag is active so this shouldn't sneak up on you.

### The tree is empty after sync

- `docket sync` to force a pull, or `docket sync --full` to ignore the watermark.
- Confirm your scope filter returns anything with the provider's native UI. Use the in-app settings (`,`) to widen the scope, or re-run `docket setup --step=scope`.
- Check the log file (`docket status` shows the path) for provider errors.

### The TUI feels cramped

- `Ctrl+F` maximizes the focused pane; `Ctrl+F` again restores the three-pane layout.
- `Ctrl+Left` / `Ctrl+Right` resize panes by 5% each press.
- Pick a denser theme with `Ctrl+T` — preview on highlight, commit on Enter, revert on Esc.

### Something else

- `docket setup` is always safe to re-run (whole wizard or a single `--step=`). The browser wizard (`make serve` → bootstrap mode) is reachable any time you delete or rename `config.toml`.
- `docket status` (`-v` for recent events) is the fastest health check — it shows paths, cache counts, sync state, MCP fleet, telemetry, and HTTP state in one screen.
- Open the in-app settings with `,` (TUI) or **Settings** (web) to fix saved values without touching `config.toml` by hand.
- During development, run everything via `make` — `make serve`, `make token`, `make check`, `make clean-workspace`. The targets pass `--workspace=./.docket-dev` for you, so logs and cache stay in the repo. `uv run docket …` without the workspace flag writes to your platform-default paths, which is *correct* for a daily-driver install but surprising mid-session.

Still stuck? `tests/` has worked examples for every feature — the TUI pilot tests (`tests/pilot/test_tui_*.py`) double as behavioural documentation for "this is how feature X is expected to behave."
