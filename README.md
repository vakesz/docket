# Docket

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-9-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![Prisma](https://img.shields.io/badge/Prisma-7-2d3748?logo=prisma)](https://www.prisma.io)
[![Self-hostable](https://img.shields.io/badge/self--hostable-Docker-2496ed?logo=docker&logoColor=white)](https://docs.docker.com)

> Browser-first work-item triage — Postgres-backed, multi-provider, with an AI assistant that asks before it writes.

One web app over your GitHub Issues and Azure DevOps work items. The backlog, the selected item, and a chat panel live on the same screen. Every write — UI button, agent tool, raw API — flows through a **proposal → diff → confirm** gate, so the assistant can never quietly transition a ticket, edit a description, or post a comment behind your back.

**Stack:** Next.js 16 App Router · tRPC v11 · Prisma 7 · Postgres 16 · NextAuth v5 · Node 22 (pnpm 9)

---

## Self-hosting

```bash
git clone <repo-url> docket && cd docket
docker compose up -d
open http://localhost:3000   # opens the setup wizard
```

On first boot the entrypoint generates `AUTH_SECRET` and `SECRETS_KEY`, applies the schema, and opens the setup wizard. The wizard collects an OAuth provider (GitHub, Azure DevOps, or both) and an optional default LLM (any OpenAI-compatible endpoint). Submitting it flips `setup.complete` and you're in. All further config lives in the database and is editable live from `/settings` — no redeploy needed.

**Prerequisites:** Docker Engine 27+ with Compose v2 · a registered OAuth App · an OpenAI-compatible API key (skippable)

**Skip the wizard** by copying `.env.example` to `.env` and filling the `DEV_*` block — the bootstrap seed writes the rows on boot:

```bash
cp .env.example .env
$EDITOR .env   # PUBLIC_BASE_URL, POSTGRES_PASSWORD, DEV_GITHUB_*, DEV_OPENAI_API_KEY
docker compose up -d
```

| Volume | Contents |
| --- | --- |
| `db-data` | Postgres data directory |
| `docket-secrets` | `AUTH_SECRET` + `SECRETS_KEY` — persists across `down`, wiped only by `down -v` |

```bash
docker compose up -d          # start
docker compose logs -f app    # follow logs
docker compose down           # stop (data persists)
docker compose down -v        # stop + wipe everything
docker compose pull && docker compose up -d --build   # update
```

> **`SECRETS_KEY` gotcha.** Encrypted rows are bound to the key that wrote them. If you point a local dev instance at a Docker-managed database with a different key in `.env.local`, decryption will fail. Use one key throughout, or wipe with `down -v` and start clean.

---

## Local development

```bash
corepack enable          # one-time, activates the pinned pnpm version
pnpm install
cp .env.example .env.local
$EDITOR .env.local       # DATABASE_URL required; DEV_* seeds optional
pnpm dev                 # prisma db push + seed + next dev (Turbopack)
```

Leave `DEV_*` empty and you'll land on the setup wizard at `http://localhost:3000`. If you don't have a local Postgres, `docker compose up -d db` starts just the bundled DB service.

```bash
pnpm dev                 # next dev (Turbopack) + auto-seed
pnpm build && pnpm start # production build
pnpm check               # biome + tsc + vitest
pnpm test                # vitest
pnpm test:watch          # vitest watch
pnpm exec prisma migrate dev   # schema migration
pnpm exec prisma db push       # push schema without a migration file
pnpm exec prisma generate      # regenerate client into src/db/generated/
pnpm exec prisma studio        # browse the DB
```

---

## Providers

| Provider | Sign-in | Notes |
| --- | --- | --- |
| **GitHub** | OAuth | Issues + PRs. Backlog grouped by state bucket. PR-link discovery. Enterprise via `baseUrl`. |
| **Azure DevOps** | OAuth via Microsoft Entra ID | Work items grouped Epic → Feature → Story → Task → Bug. Markdown ↔ HTML round-trip. |

Adding a new provider (Jira, Linear, …) is an isolated `src/providers/<name>/` package plus two registry entries. LLM vendors follow the same pattern with a new adapter in `src/agent/llm/`. Walkthroughs: [docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md), [docs/ADDING_AN_LLM.md](docs/ADDING_AN_LLM.md).

---

## Features

### Workspace
- **Three-pane shell** — backlog / item detail / chat on one screen. Filter by state, assignee, and provider scope axes; free-text search across cached items.
- **Saved views** — named filters per user, one optional default per project.
- **Watchlist & Recents** — pin items that survive cache scope changes; recently viewed items surface on the home screen and in the command palette.
- **Command palette** (`⌘/Ctrl+K`) — jump to projects, items, and actions. `?` opens a shortcut cheat sheet.
- **Reactions** — emoji reactions synced with the provider (UI-only).
- **Triage home** — landing screen surfaces pending proposals and recently viewed items.

### Chat & Agent
- **Streaming chat** over SSE, anchored to an item or project-wide. Stop button, per-conversation LLM override, auto-compaction, and a "Suggest next action" one-click prompt.
- **Read-only tools** — item/PR/commit/CI reads, memory and source reads, `ask_user_question`, `web_fetch` (HTML auto-cleaned to Markdown; `raw: true` to opt out), `search_items`, `list_audit_log`, `get_pull_request_diff`, `search_code`, `search_pull_requests`, plus project-scoped MCP tools.
- **Mutating tools** — `propose_transition`, `propose_description_patch`, `propose_comment`, `propose_new_item`, `propose_item_tags`, `propose_memory_write`, `propose_memory_delete`. All stage proposals; none execute without human confirmation.
- **Recommendation modes** — likely-already-resolved (close-as-done plus a comment linking the resolving PR), incomplete-info (probe sources/memory before asking the user), duplicate / related (close-as-duplicate via `close_duplicate` intent or a cross-link comment), and short illustrative code snippets (deterministically capped per project policy). Project-toggleable under Settings → Recommendations.
- **Editable system prompt** — the agent's base prompt and per-kind prefixes are global settings under Settings → Agent prompts. Empty fields fall back to the bundled defaults; the prefix stays byte-stable for any given configuration.
- **Multi-LLM** — any OpenAI-compatible endpoint. Role-split: separate `chat` and `guardrail` provider rows so a cheaper model handles safety checks without affecting the main chat model.
- **Guardrail** — pluggable safety pipeline (`noop` / `pattern` / `llm-judge` / `composite`). Toggles for prompt-injection, off-topic, scope, and output checks.

### Proposals & Mutations
- **Proposal-first** — every write stages a `Proposal`, renders a side-by-side diff, and requires an explicit confirm. No fast lane for any origin (UI, agent, or HTTP).
- **Auto-accept floor** — UI-origin `comment_add` and `reaction_toggle` always auto-confirm (no policy gate); per-project `proposals.auto-accept-extra-kinds` opts in additional local-DB kinds on top. Agent proposals always wait for a human regardless.
- **Project memory & sources** — durable facts and reference docs per project. Agent reads; humans write.
- **MCP fleet** — per-project HTTP MCP servers; tools namespaced `${server}__${tool}`, rebuilt on project switch, stripped in read-only mode.
- **Inbound-change injection** — external edits during an active chat arrive as synthetic system messages so the model doesn't reason over stale state.

### Administration
- **Roles** — `viewer` / `member` / `approver` per project, plus owner. Approvers confirm proposals; viewers cannot mutate.
- **Read-only mode** — system-wide `app.read-only` flag refuses every mutation and strips mutating agent tools.
- **Audit log** — append-only; one row per proposal confirm/reject, retained even after user deletion.
- **Cost budgeting** — per-deployment LLM spend cap (block or warn mode). Analytics dashboard under `/settings`.
- **Secrets at rest** — LLM API keys and OAuth client secrets AES-256-GCM-encrypted (`enc:v1:<iv>:<ct+tag>`).

---

## Architecture

```text
Browser (src/ui/  +  src/app/)
        |
        v
tRPC routers  (src/server/routers/)
        |
        +--> per-feature services  (src/server/<feature>/)
        |       reads Prisma · calls providers via registry · stages proposals
        |
        +--> Proposal executor  (src/server/proposals/executor.ts)
        |       sole caller of provider write methods · records audit · refreshes cache
        |
        +--> Agent loop  (src/agent/loop.ts)
                byte-stable prompt prefix · ordered tool registry · SSE stream
                mutating tools stage proposals — user confirms in the chat UI
```

Full contract — invariants, tRPC procedure layers, tool-registration order, forbidden import edges, testing conventions: [AGENTS.md](AGENTS.md).

---

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).
