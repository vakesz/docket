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
- [Optional: add more providers later](#optional-add-more-providers-later)
- [Files Docket creates](#files-docket-creates)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| Python 3.12+ | Runtime | [python.org](https://www.python.org/) or `pyenv` |
| [`uv`](https://docs.astral.sh/uv/) | Packaging + venv manager | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| A true-color terminal | The TUI leans on theme colors | Any modern terminal (iTerm2, Alacritty, WezTerm, Windows Terminal) |
| Provider credentials | See the per-provider sections below | — |
| Azure OpenAI deployment | For chat / suggestions | Endpoint + deployment name + API key |

You can skip the LLM entirely — Docket launches without it, you just lose chat. Pass `--no-chat` to `docket open` to silence the "chat disabled" toast.

---

## Install

```bash
git clone <repo-url> docket
cd docket
uv sync
```

`uv sync` creates a venv, installs the runtime deps and the dev extras, and leaves you ready to run `uv run docket …`. No global `pip install` needed.

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
uv run docket setup --step=ado
```

The top-level wizard is a small orchestrator that:

1. Discovers which providers already exist in `config.toml`.
2. Offers **add / remove / set-active** for them.
3. Falls through to the shared steps: optional telemetry, prompt templates, database init, first smoke sync. LLM credentials are configured via environment variables — see [Wire up the LLM](#wire-up-the-llm-azure-openai).

Provider add is where the per-backend questions live. If you just want to get going with a single Azure DevOps project, the wizard will do that end-to-end with no extra flags.

---

## Provider walkthroughs

### Azure DevOps

**Prereqs**

```bash
az login                          # interactive sign-in
az account show                   # sanity check
```

The setup wizard shells out to `az` for token acquisition — it won't prompt you for a PAT.

**Wizard questions**

1. **Organization URL** — `https://dev.azure.com/<org>`
2. **Project name** — the ADO project you want to triage
3. **Scope filter** — defaults to "my items in the current iteration". You can override by team, area path, iteration path, or assignee. Each is optional.
4. **Work item types** — auto-discovered from the project's process template. No need to type anything unless you want to override the defaults.

**What it does under the hood**

- Saves `providers.<name>.config = { organization, project }` and a default scope to `config.toml`.
- Runs a `list_changes_since(None, ...)` probe to confirm auth works.
- Creates the SQLite cache and pulls the first page of items.

**Notes**

- If your project uses HTML-only description fields, Docket detects this during the probe and flips a flag in `sync_state` so Markdown ↔ HTML conversion happens transparently.
- Canonical states are translated in `providers/azure_devops/state_map.py`. If a custom state isn't mapped cleanly, add it there — the rest of the app deals in canonical `ItemState` only.

---

### GitHub

**Prereqs**

```bash
gh auth login                     # recommended — uses your existing gh session
gh auth status                    # confirm the active account
```

Docket reads `gh auth token` at startup and falls back to the `GITHUB_TOKEN` environment variable if `gh` isn't installed. No PAT prompt during setup.

**Wizard questions**

1. **Repo picker** — Docket scans `/user/repos` for repos you own or collaborate on, plus every org you're a member of via `/orgs/{org}/repos` (this is deliberate — `/users/{login}/repos` would miss private repos you have access to). Pick one from the list.
2. If nothing comes back (no `gh`, no orgs, no accessible repos), the wizard drops to a manual `owner/name` prompt.
3. **Scope filter** — GitHub's query params only honor `assignee`, so team / area / iteration options are hidden. `@me` expands to the authenticated user.

**What it does under the hood**

- Saves `providers.<name>.config = { default_repo: "owner/name" }`.
- Issues + PRs both map to the canonical `Item`. Label-based kind guessing: `bug` → BUG; `enhancement|feature|story` → STORY; `epic` → EPIC; default → TASK. PRs are always TASK.
- Canonical id format is `owner/name#number` — stable across syncs.

**Tips**

- The agent tool `find_related_prs` registers itself automatically for GitHub — ask the assistant "any PRs that might close this?" and it'll scan the repo's recent PRs.
- GitHub REST has no direct attachment upload, so `upload_attachment` raises a descriptive `ProviderUnreachableError`. The workaround Docket expects is posting a comment with an externally-hosted URL.

---

### github_stub (demo / tests)

In-memory reference provider. Zero auth, zero network. Useful when:

- You want to poke at the TUI without wiring a real backend.
- You're developing a new feature and want determinism.
- You're writing a test and need something that satisfies the `WorkItemProvider` Protocol.

```bash
uv run docket setup provider add demo --type github_stub --display-name "Demo"
```

The wizard will ask for a `default_repo` (any `owner/name` string works — it's just a label).

---

## Wire up the LLM (Azure OpenAI)

LLM credentials live in `.env` only — never in `config.toml`. Set:

| Variable | Purpose |
| --- | --- |
| `AZURE_OPENAI_ENDPOINT` | Deployment base URL (`https://<resource>.openai.azure.com/`) |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (the GPT-5 / equivalent model) |
| `AZURE_OPENAI_API_KEY` | API key |
| `AZURE_OPENAI_API_VERSION` | Optional; defaults to the latest published version |

`.env` resolution order (first hit wins):

1. Repo-local `.env` in `$PWD`
2. User-level `.env` under `$XDG_CONFIG_HOME/docket/.env`

Both are gitignored.

You can skip the LLM entirely. The TUI launches without chat; `docket open --no-chat` silences the warning if you want it quiet.

### Prompt templates

Docket scaffolds `system_base.md` and `kind_<kind>.md` under `prompts/`. Edit them at any time — the loader keeps an mtime cache, so saved changes take effect on the next turn without restarting the app. The in-app Prompt Library (`p`) opens an editor backed by the same files.

The prompt prefix `[system + kind template] → [ticket snapshot] → ---` is byte-stable on purpose so Azure OpenAI prompt caching hits on every follow-up turn. Don't interpolate timestamps or scope into the prefix; those go after the `---` divider.

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

Inside the TUI, the command palette (`Ctrl+P`) has a **Switch provider** entry — the tree, scope, and status bar all re-bind to the new active provider without restarting.

Third-party providers can ship as separate pip packages via the `docket.providers` entry-point group. The Protocol contract and cross-cutting test expectations are documented in the [README's "Adding a provider" section](../README.md#adding-a-provider).

---

## Files Docket creates

Resolved via `platformdirs` → XDG on Linux, Application Support on macOS, `%APPDATA%` on Windows.

| Path (macOS shown) | Purpose |
| --- | --- |
| `~/Library/Application Support/docket/config.toml` | Providers, scopes, LLM settings, UI preferences |
| `~/Library/Application Support/docket/.env` | Azure OpenAI key + optional provider secrets |
| `~/Library/Application Support/docket/prompts/system_base.md` | System prompt, editable from the app |
| `~/Library/Application Support/docket/prompts/kind_<kind>.md` | Per-kind prompt (one per `ItemKind`) |
| `~/Library/Caches/docket/docket.db` | SQLite cache (items, comments, messages, watchlist, FTS5) |
| `~/Library/Logs/docket/docket.log` | Structlog output |

The SQLite cache keeps a `PRAGMA user_version`, but Docket intentionally supports
one cache schema at a time right now. If the on-disk schema is older, startup
drops the cached tables and re-pulls items instead of running migrations.

---

## Troubleshooting

### `docket` prints "Provider '…' is not configured"
Re-run `uv run docket setup` to step through provider configuration again. If you've clean-checked out a newer version and the old config.toml is incompatible, the wizard will detect this and ask before overwriting.

### Azure auth fails during setup
```bash
az account show                   # verify a live session
az login                          # re-authenticate if needed
az account set --subscription <id-or-name>   # if you have multiple subscriptions
```
Re-run `docket setup --step=ado`.

### GitHub setup shows no repos
- Confirm `gh auth status` — the CLI must be signed in as the account you want to triage under.
- Check `gh api user --jq .login` — if this errors, your token lacks `read:user` scope. Run `gh auth refresh -s read:user,read:org,repo`.
- If you only want public repos, any `GITHUB_TOKEN` with `public_repo` scope works — set it in `.env` and skip the `gh` step.

### "Chat disabled: set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT …"
The TUI didn't find Azure OpenAI credentials. Either:
- Add the env vars (`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`) to your `.env`, or
- Launch with `docket open --no-chat` to silence the warning entirely.

### "Read-only mode — mutations disabled"
Either you passed `--read-only` or `DOCKET_READ_ONLY=1` is set in your environment. Unset it and relaunch. The status bar shows a `READ-ONLY` badge while the flag is active so this shouldn't sneak up on you.

### The tree is empty after sync
- `docket sync` to force a pull.
- Confirm your scope filter returns anything with the provider's native UI. For ADO, swap the default `assignee="@me"` for a looser filter in settings (`,`).
- Check `~/Library/Logs/docket/docket.log` for provider errors.

### The TUI feels cramped
- `Ctrl+F` maximizes the focused pane; `Ctrl+F` again restores the three-pane layout.
- `Ctrl+Left` / `Ctrl+Right` resize panes by 5% each press.
- Pick a denser theme with `Ctrl+T` — preview on highlight, commit on Enter, revert on Esc.

### Something else
- `docket setup` is always safe to re-run.
- Open the in-app settings with `,` to fix saved values without touching `config.toml` by hand.
- Logs live next to the cache under the Docket paths above.

Still stuck? `tests/` has worked examples for every feature — the TUI pilot tests (`tests/test_tui_*.py`) double as behavioural documentation for "this is how feature X is expected to behave."
