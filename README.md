# Docket

> **Browser-first work-item triage — Postgres-backed, multi-provider, an AI assistant that asks before it writes.**

Browse · Filter · Chat · Transition · Patch · Create — through a Next.js web app, with every mutation visible behind a confirm step.

---

## Contents

- [Why Docket](#why-docket)
- [Self-hosting (Docker)](#self-hosting-docker)
- [Local development](#local-development)
- [Providers](#providers)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Testing](#testing)
- [License](#license)

---

## Why Docket

Most triage tools make you context-switch between a browser, a Kanban board, and a chat window. Docket puts the backlog, the selected item, and an LLM assistant on the same screen — and keeps every write behind a visible confirm step.

- **Postgres-backed cache.** The provider stays the source of truth; Docket caches what you've seen for instant browsing and search.
- **Multi-provider.** One canonical model, adapters today for **GitHub** and **Azure DevOps** (Microsoft Entra ID OAuth). Adding a provider is a server-side `WorkItemProvider` implementation plus a state-mapping module.
- **Project-scoped.** One project per provider scope, with its own memory, sources, and MCP fleet.
- **Safe by design.** Every mutation — UI, API, or AI-initiated — flows through the same proposal → diff → confirm gate. Read-only mode strips write tools from the agent and blocks every mutation endpoint.
- **Prompt-cache friendly.** The system + ticket-snapshot prefix is byte-stable across turns, so the LLM prompt cache hits on every follow-up.

---

## Self-hosting (Docker)

The fastest way to get a working Docket: `docker compose up`. The bundled stack runs Postgres 16 alongside the app, applies the schema on first boot, and seeds the initial provider rows from environment variables.

### Prerequisites

- Docker Engine 27+ (with `docker compose` v2)
- A registered **GitHub OAuth App** for sign-in:
  - <https://github.com/settings/developers> → New OAuth App
  - **Authorization callback URL:** `${PUBLIC_BASE_URL}/api/auth/callback/github`
- An **OpenAI API key** for the agent (or any other supported LLM — see [Providers](#providers))

### First boot

```bash
git clone <repo-url> docket && cd docket

# 1. Generate AUTH_SECRET and SECRETS_KEY into .env (also creates it from .env.example).
bin/generate-secrets.sh

# 2. Edit .env — set PUBLIC_BASE_URL, change POSTGRES_PASSWORD off the default.
$EDITOR .env

# 3. Seed the initial provider rows so you can sign in on the first boot.
cp compose.override.example.yml compose.override.yml
$EDITOR compose.override.yml   # paste DEV_OPENAI_API_KEY, DEV_GITHUB_CLIENT_ID/SECRET

# 4. Bring up the stack. First boot pulls postgres:16, builds the app image, and runs the seed.
docker compose up -d

# 5. Watch the logs the first time so you see the schema apply + seed run.
docker compose logs -f app
```

Visit `${PUBLIC_BASE_URL}` (default `http://localhost:3000`), sign in via GitHub, and you're in. From `/admin` the operator can add more LLM providers, more OAuth providers, and rotate keys at any time — no redeploy.

### How the bootstrap works

The stack ships with a single bootstrap mechanism: **the seed script reads the `DEV_*` env vars on every boot and writes any missing rows.** Once both an LLM provider and an OAuth provider exist, a global `setup.complete` sticky bit flips and the seed becomes a no-op forever after — admin UI edits are never stomped, even if the env vars still hold older values.

This means:

- Rotating a key in `compose.override.yml` *does not* update the DB after first boot. Use the admin UI.
- Removing the seed env vars after first boot is harmless.
- A clean `docker compose down -v` (wipes the volume) re-runs the seed from current env values on the next `up`.

### What lives where

| Bootstrap env (`.env`) | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | Canonical URL the app is reached at — NextAuth needs it for OAuth callbacks. |
| `AUTH_SECRET` | NextAuth session-cookie encryption. Rotating it logs everyone out. |
| `SECRETS_KEY` | 32-byte base64 key used to AES-GCM-encrypt provider secrets at rest. Rotating it requires re-encrypting every existing row. |
| `POSTGRES_USER`/`PASSWORD`/`DB` | Postgres credentials for the bundled `db` service. Override `DATABASE_URL` to use an external Postgres. |

| Bootstrap seed (`compose.override.yml`) | Writes |
| --- | --- |
| `DEV_OPENAI_API_KEY` | One `LlmProvider` row (kind `openai`). First row also becomes the global default. |
| `DEV_GITHUB_CLIENT_ID` + `DEV_GITHUB_CLIENT_SECRET` | One `OauthProviderConfig` row (kind `github`). |

Everything else lives in the database and is managed from `/admin/llm-providers` and `/admin/oauth-providers`.

### Operations

```bash
docker compose up -d          # start
docker compose logs -f app    # follow logs
docker compose restart app    # apply env-only changes
docker compose down           # stop (data persists)
docker compose down -v        # stop + wipe the database
docker compose pull && docker compose up -d --build   # update
```

---

## Local development

```bash
bun install
cp .env.local.example .env.local
$EDITOR .env.local       # at minimum: DATABASE_URL, AUTH_SECRET, plus DEV_* seeds for sign-in
bun run dev              # runs predev seed + next dev
```

`bun run dev` runs `bin/seed-dev.ts` first, which reads `.env.local` and writes the same `LlmProvider` / `OauthProviderConfig` rows as the docker entrypoint — so the runtime path is identical to production (DB-driven, no env fallbacks).

If you don't have a local Postgres, point `DATABASE_URL` at `docker compose up -d db` running just the bundled DB service, or any reachable Postgres (Neon dev branch, etc).

### Common commands

```bash
bun run dev              # next dev (Turbopack) + auto-seed
bun run build            # next build (production)
bun run start            # next start (production)
bun run check            # biome + tsc + vitest
bun run test             # vitest run
bun run test:watch       # vitest in watch mode
bunx prisma migrate dev  # apply schema changes against your dev DB
bunx prisma studio       # browse the DB
```

---

## Providers

| Provider | Sign-in | Notes |
| --- | --- | --- |
| **GitHub** | OAuth (`OauthProviderConfig` kind=`github`) | Issues + PRs mapped to the canonical model. The `find_related_prs` agent tool scans recent PRs for id/keyword mentions. |
| **Azure DevOps** | OAuth via Microsoft Entra ID (`OauthProviderConfig` kind=`azure_devops`) | Production path. Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |

To add Jira, Linear, or anything else: implement the `WorkItemProvider` Protocol in `src/server/providers/<name>/`, register it in `src/server/providers/registry.ts`, and add the OAuth/PAT flow to `src/server/providers/auth-build.ts`. The architecture test in `src/__arch__/no-router-provider-import.test.ts` keeps concrete provider modules out of the routers — you only import them at the registry boundary.

---

## Configuration

Docket has two config surfaces:

- **Env vars** — only the four bootstrap secrets above. Rotation requires a restart; everything else is live.
- **Database** — every other knob. Provider configs (`LlmProvider`, `OauthProviderConfig`), per-project settings (saved views, default LLM, MCP fleet), per-user settings (prompts, theme), audit log. Edited from the admin UI under `/admin` and from per-project settings.

Secrets at rest (LLM API keys, OAuth client secrets, MCP headers) are encrypted with `SECRETS_KEY` using AES-256-GCM. The wire format is `enc:v1:<iv>:<ct+tag>`. Plain-text rows from before encryption was wired remain readable; the next write re-encrypts them.

The global `setup.complete` flag in the `Setting` table is the sticky bit that determines whether a fresh boot needs the bootstrap seed.

---

## Architecture

Surfaces (`src/app/` for pages, `src/app/api/` for HTTP, tRPC routers in `src/server/routers/`) are thin adapters that call into services in `src/server/`. Services talk to providers via the `WorkItemProvider` Protocol and to Postgres via Prisma. Concrete providers live behind the protocol: `github`, `azure_devops`, with stubs available for tests.

The mutation surface is **proposal-first**: every write — agent-initiated, UI-initiated, or HTTP-initiated — builds a `Proposal` row, the user sees a diff, and only then does the confirm endpoint dispatch the write through the registered mutation handler. Read-only mode strips mutating tools from the agent fleet and refuses every mutation endpoint.

For the full contract — invariants, the proposal-first mutation pattern, tool-registration order, testing conventions — see [AGENTS.md](AGENTS.md).

---

## Testing

```bash
bun run test          # vitest run (full suite)
bun run check         # biome + tsc + vitest
```

Test layout, fixtures, and the architectural guards are documented in [AGENTS.md](AGENTS.md).

---

## License

MIT.
