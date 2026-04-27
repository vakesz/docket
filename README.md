# Docket

> **Browser-first work-item triage — Postgres-backed, multi-provider, with an AI assistant that asks before it writes.**

One web app over your GitHub Issues and Azure DevOps work items. The backlog, the selected item, and a chat panel sit on the same screen. Every mutation — UI button, agent tool, raw API — flows through a proposal → diff → confirm gate, so the assistant can never quietly transition a ticket, edit a description, or post a comment behind your back.

---

## Contents

- [What it does](#what-it-does)
- [The shape](#the-shape)
- [Self-hosting (Docker)](#self-hosting-docker)
- [Local development](#local-development)
- [Providers](#providers)
- [Configuration](#configuration)
- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Testing](#testing)
- [License](#license)

---

## What it does

- **Browse** the backlog from a Postgres cache that mirrors the provider — instant filter, search, and saved views even on slow networks.
- **Chat** with an LLM assistant scoped to the current item or the project. The assistant has read-only tools for items, PRs, commits, CI, project memory, project sources, and any project-scoped MCP servers.
- **Transition** items, **patch** descriptions, **edit** tags, **add** comments, **create** new items, **write** project memory — all by *staging a proposal*. The proposal renders a side-by-side diff and a separate confirm endpoint dispatches the actual provider write.
- **Pin** items to a per-user watchlist. **Save** named filters as views. **Anchor** the LLM on per-project memory and per-project source documents. Plug in **MCP servers** to expose extra tools to the agent.
- **Audit** every confirmed or rejected proposal — append-only `Audit` table, owner-visible.
- **Read-only mode** is system-wide: a single `app.read-only` flag refuses every mutation endpoint and strips mutating tools from the agent fleet.

The provider stays the source of truth. Postgres caches what the user has seen; sync runs from the provider into Prisma; confirmed writes refresh the cached row from the response.

## The shape

- **Next.js 16 App Router** + **tRPC v11** + **Prisma 7** + **Postgres 16** + **NextAuth v5**, running on **Bun 1.3**.
- One Node-shaped process serves the SSR pages (`src/app/`), the SPA-style React UI (`src/ui/`), the tRPC API at `/api/trpc/*`, and the SSE chat stream at `/api/projects/:id/conversations/:id/stream`.
- **Multi-provider** — built-ins are `github` and `azure_devops`. Specs are registered in `src/server/provider-registry.ts`; concrete instances are built per-user via `src/server/providers/build.ts` (work-item) and `src/server/providers/auth-build.ts` (NextAuth sign-in).
- **Multi-project** — one project per provider scope. Per-project: memory, sources, MCP fleet, default LLM, saved views.
- **Multi-LLM** — `LlmProvider` rows are vendor-tagged (`openai` ships, others slot in) and the agent loop talks to a vendor-neutral `LlmAdapter`. Per-conversation override + per-project default.
- **Encrypted at rest** — provider client secrets and LLM API keys are AES-256-GCM-encrypted with `SECRETS_KEY`.

---

## Self-hosting (Docker)

The fastest way to a working Docket: `docker compose up`. The bundled stack runs Postgres 16 alongside the app, applies the schema on first boot, and seeds the initial provider rows from environment variables.

### Prerequisites

- Docker Engine 27+ (with `docker compose` v2)
- A registered **GitHub OAuth App** for sign-in:
  - <https://github.com/settings/developers> → New OAuth App
  - **Authorization callback URL:** `${PUBLIC_BASE_URL}/api/auth/callback/github`
- An **OpenAI API key** for the agent (other vendors can be added once their adapter ships — see [Providers](#providers))

### First boot

```bash
git clone <repo-url> docket && cd docket

# 1. Generate AUTH_SECRET and SECRETS_KEY into .env (also copies .env.example).
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

Visit `${PUBLIC_BASE_URL}` (default `http://localhost:3000`), sign in via GitHub, and you're in. From `/settings` an operator can add more LLM providers, more OAuth providers, and rotate keys at any time — no redeploy.

### How the bootstrap works

The stack ships with a single bootstrap mechanism: **the seed script reads the `DEV_*` env vars on every boot and writes any missing rows.** Once both an LLM provider and an OAuth provider exist, a global `setup.complete` sticky bit flips and the seed becomes a no-op forever after — UI edits are never stomped, even if the env vars still hold older values.

This means:

- Rotating a key in `compose.override.yml` *does not* update the DB after first boot. Use `/settings`.
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

Everything else lives in the database and is managed from `/settings`.

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
bun run dev              # runs predev seed + next dev (Turbopack)
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
bunx prisma db push      # push schema without producing a migration (dev/docker entrypoint)
bunx prisma generate     # regenerate the client into src/db/generated/
bunx prisma studio       # browse the DB
```

---

## Providers

| Provider | Sign-in | Notes |
| --- | --- | --- |
| **GitHub** | OAuth (`OauthProviderConfig` kind = `github`) | Issues + PRs mapped to the canonical model. Backlog grouped by state bucket. The `find_related_pull_requests` agent tool scans recent PRs for id/keyword mentions. Supports GitHub Enterprise via `baseUrl`. |
| **Azure DevOps** | OAuth via Microsoft Entra ID (`OauthProviderConfig` kind = `azure_devops`) | Work items mapped to the canonical model. Backlog grouped by kind (Epic → Feature → Story → Task → Bug). Detects HTML-only description fields and converts Markdown ↔ HTML on round-trip. |

To add Jira, Linear, or anything else: implement the `WorkItemProvider` interface in `src/providers/<name>/`, register the spec in `src/server/provider-registry.ts`, and wire NextAuth in `src/server/providers/auth-build.ts`. The architecture test in `src/__arch__/no-router-provider-import.test.ts` keeps concrete provider modules out of the routers — you only import them at the registry boundary. Full walkthrough in [.docs/ADDING_A_PROVIDER.md](.docs/ADDING_A_PROVIDER.md).

LLM vendors follow the same shape: a new file in `src/agent/llm/` implementing `LlmAdapter` and a registry switch entry. The architecture test in `src/__arch__/no-llm-vendor-leak.test.ts` keeps vendor SDKs (`openai`, future Anthropic / Gemini / etc.) quarantined to the adapter layer.

---

## Configuration

Docket has two config surfaces:

- **Env vars** — only the four bootstrap secrets above. Rotation requires a restart; everything else is live.
- **Database** — every other knob. Provider configs (`LlmProvider`, `OauthProviderConfig`), per-project settings (saved views, default LLM, default temperature, MCP fleet, web-fetch toggle), per-user settings (prompts, theme), audit log. Edited from `/settings` and from per-project settings.

Secrets at rest (LLM API keys, OAuth client secrets) are encrypted with `SECRETS_KEY` using AES-256-GCM. The wire format is `enc:v1:<iv>:<ct+tag>`. Plain-text rows from before encryption was wired remain readable; the next write re-encrypts them.

The global `setup.complete` flag in the `Setting` table is the sticky bit that determines whether a fresh boot needs the bootstrap seed. While it's false, every authenticated route redirects to `/setup-required`.

---

## Capabilities

- **Backlog browsing** — three-pane shell (list / detail / chat). Filter by state bucket, assignee, and provider-declared scope axes (e.g., AzDO area/iteration). Free-text search across cached items.
- **Saved views** — per-user named filters, with one optional default per project.
- **Watchlist** — per-user pinned items that survive cache scope changes (the row may outlive the provider item).
- **Conversations** — chat anchored on an item or project-wide. Streaming over SSE. Per-conversation LLM override. Auto-compaction folds old turns into a synthetic summary so the prompt cache stays warm.
- **Proposals** — staged mutations with side-by-side diffs. Builders cover state transitions, description patches, comments, tag edits, new items, and memory writes/deletes. An optional **advisory** field surfaces builder warnings ("comment echoes description", etc.) in the confirm dialog.
- **Project memory** — durable facts (label conventions, runbooks, design notes) the agent reads and proposes writes to. Mutations go through the proposal pipeline.
- **Project sources** — read-only-for-the-agent reference docs (requirements, design docs, screenshots). Source writes are human-driven only; the architecture test `src/__arch__/no-source-mutation-tools.test.ts` enforces this.
- **MCP fleet** — per-project HTTP-only MCP servers. Tools land in the agent registry namespaced as `${serverName}__${toolName}` between the source-readonly and provider-mutating groups.
- **Web fetch** — agent tool gated by a per-project setting. Validates against an SSRF allowlist + content-type + max-size guards. Every call is logged to `WebFetchEvent` with status (`ok`, `denied_ssrf`, `denied_host`, `denied_size`, `denied_type`, `denied_disabled`, `error`).
- **Inbound-change injection** — when a sync detects a material external edit (state, title, description, assignee), active conversations on that item get a synthetic system message so the assistant doesn't keep reasoning over a stale snapshot.
- **Roles** — `viewer` / `member` / `approver` per `ProjectMembership`, plus the project owner. Approvers can confirm/reject proposals; viewers cannot mutate; owners always have full control.
- **Read-only mode** — flip the global `app.read-only` Setting to refuse every mutation procedure and strip mutating tools from the agent.
- **Audit log** — append-only `Audit` table; one row per proposal confirm/reject. Foreign keys to `User` use `onDelete: SetNull` so user deletion never erases the audit trail.
- **Cost budgeting** — per-deployment LLM spend cap (block or warn mode), surfaced in the settings panel.

---

## Architecture

```text
Browser (React UI under src/ui/, Next pages under src/app/)
        |
        v
Next.js App Router  ── server components query tRPC via src/server/trpc-caller.ts
        |
        v
tRPC routers (src/server/routers/index.ts)  ── one per feature (items, conversations,
        |                                       proposals, memory, sources, mcp,
        |                                       views, settings, llm, oauth, watchlist,
        |                                       suggestions, projects, analytics, health)
        |
        +--> per-feature service modules (src/server/<feature>/...)
        |       - reads/writes Prisma via src/server/db.ts
        |       - calls providers via getProviderSpec + buildProviderForUser
        |       - stages writes via src/server/proposals/builders.ts
        |
        +--> Proposal executor (src/server/proposals/executor.ts)
        |       - the ONE place provider write methods are called
        |       - records audit, refreshes cached Item, returns updated proposal
        |
        +--> Agent loop (src/agent/loop.ts)
                - prompt prefix from src/agent/prompt.ts (byte-stable)
                - tools from src/agent/tools/registry.ts (ordered)
                - LLM via src/agent/llm/openai.ts (vendor-quarantined)
                - SSE stream at src/app/api/projects/[projectId]/conversations/
                  [conversationId]/stream/route.ts
                - mutating tools stage proposals; user confirms in UI
```

The mutation surface is **proposal-first**: every write — agent-initiated, UI-initiated, or HTTP-initiated — builds a `Proposal` row, the user sees a diff, and only then does the confirm endpoint dispatch the write through the proposal executor. Read-only mode strips mutating tools from the agent fleet and refuses every mutation endpoint.

Forbidden edges (each one has a regex-scanning arch test under `src/__arch__/`):

- Routers → concrete provider modules (`no-router-provider-import.test.ts`)
- Anyone → provider write methods (`.transition(`, `.patchDescription(`, `.uploadAttachment(`, `.addComment(`, `.createItem(`, `.setTags(`), except `proposals/executor.ts` (`no-provider-write-leak.test.ts`)
- Anyone → `db.audit.create`, except `proposals/executor.ts` (`no-audit-write-leak.test.ts`)
- Anyone → Octokit, except `src/providers/github/**` (`no-octokit-leak.test.ts`)
- Anyone → LLM vendor SDKs, except `src/agent/llm/**` (`no-llm-vendor-leak.test.ts`)
- Agent → source mutation paths (`no-source-mutation-tools.test.ts`)
- Tool registration order (`tool-registration-order.test.ts`) — pinned because the ordered list contributes to the prompt-cache key.

For the full contract — invariants, the proposal-first mutation pattern, tRPC procedure layers, tool-registration order, testing conventions — see [AGENTS.md](AGENTS.md).

---

## Testing

```bash
bun run test          # vitest run (full suite)
bun run check         # biome + tsc + vitest
```

Test layout:

- `src/__arch__/` — architectural guards (regex-scanning tests that fail CI on forbidden imports).
- Co-located `*.test.ts` files for unit/service tests.
- `tests/` for integration tests against a test Postgres if the surface area grows.

Stack: Vitest with `bun run test` driving it. Arch tests are pure file-system scans — no DB, no fixtures.

---

## License

MIT.
