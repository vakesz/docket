# Docket — contract for human and AI contributors

This file is the load-bearing reference for anyone (or anything) editing the codebase. It captures invariants that aren't visible from a single grep — architecture rules enforced by tests, the proposal-first mutation pattern, and conventions the wider tooling depends on. Read it before making non-trivial changes.

## Project Snapshot

- **Next.js 16 App Router** + **tRPC v11** + **Prisma 7** + **Postgres 16** + **NextAuth v5**, running on **Bun**. One Node-shaped process serves the SSR pages (`src/app/`), the SPA-style React UI (`src/ui/`), the tRPC API at `/api/trpc/*` (`src/server/routers/`), and the SSE chat stream at `/api/projects/:id/conversations/:id/stream` (`src/app/api/`).
- **Layered ports-and-adapters.** Surfaces in `src/app/` and `src/ui/`. Canonical types in `src/core/`. Orchestration in `src/server/<feature>/` and `src/agent/`. Adapters in `src/providers/{github,azure-devops}/`, `src/server/secrets/`, `src/server/db.ts`, `src/server/logger.ts`.
- **Multi-provider.** Built-ins: `github`, `azure_devops`. Specs registered in `src/server/provider-registry.ts`; concrete instances built per-user via `src/server/providers/build.ts` (work-item) and `src/server/providers/auth-build.ts` (NextAuth sign-in).
- **Postgres-backed cache.** The provider stays the source of truth; `Item` rows in Postgres cache what the user has seen for instant filter/search. Memory, prompts, MCP server configs, settings, and the audit log all live in the same DB.
- **Project-scoped runtime.** One project per provider scope. Per-project: memory, sources, MCP fleet, default LLM, saved views.
- Primary safety property: **proposal-first mutation**. Stage a `Proposal`, render a diff, require explicit confirmation before any provider write or memory mutation.

## Commands

```bash
bun install
cp .env.local.example .env.local        # at minimum: DATABASE_URL, AUTH_SECRET, plus DEV_* seeds
bun run dev                             # predev seed (bin/seed-dev.ts) + next dev (Turbopack)

bun run build                           # next build
bun run start                           # next start (production)
bun run check                           # biome + tsc + vitest run
bun run test                            # vitest run (full suite)
bun run test:watch                      # vitest in watch mode

bunx prisma migrate dev                 # apply schema changes against your dev DB
bunx prisma db push                     # push the schema without producing a migration (dev/docker entrypoint)
bunx prisma generate                    # regenerate the client into src/db/generated/
bunx prisma studio                      # browse the DB

# Self-host stack
docker compose up -d                    # start Postgres + app
docker compose logs -f app
docker compose down                     # stop (data persists)
docker compose down -v                  # stop + wipe the database volume
bin/generate-secrets.sh                 # mint AUTH_SECRET + SECRETS_KEY into .env
```

## Non-Negotiable Rules

1. **Routers must not import concrete provider modules.** `src/server/<feature>/router.ts` and `src/server/routers/*` go through `getProviderSpec` + `buildProviderForUser` only. The only files allowed to import `@/providers/<name>/...` are: sibling files inside the same provider package, `src/server/provider-registry.ts`, `src/server/providers/build.ts`, `src/server/providers/auth-build.ts`, and the provider's own arch tests. Enforced by `src/__arch__/no-router-provider-import.test.ts`.
2. **Translate provider-native kinds and states at the boundary.** The rest of the app runs on canonical enums in `src/core/types.ts` (`ItemKind`, `ItemState`, `TransitionIntent`). Translation lives in each provider's `state-map.ts` (`src/providers/{github,azure-devops}/state-map.ts`).
3. **Provider write methods are called from exactly one place.** `src/server/proposals/executor.ts` (`confirmProposal`) is the sole caller of `.transition(`, `.patchDescription(`, `.uploadAttachment(`, `.addComment(`, `.createItem(`, and `.setTags(`. Enforced by `src/__arch__/no-provider-write-leak.test.ts` — a regex scan that ignores the executor itself and the concrete provider implementations.
4. **Every write is proposal-first.** Build a `Proposal` row via `src/server/proposals/builders.ts`, render a diff via `src/server/proposals/diff.ts`, then dispatch through `confirmProposal`. The `proposalsRouter` (`src/server/proposals/router.ts`) is the only HTTP entry point for confirmation. UI-initiated, agent-initiated, and HTTP-initiated writes all share this path — there is no fast lane.
5. **Agent mutating tools only stage proposals.** `src/agent/tools/mutating.ts` (provider mutations) and `src/agent/tools/memory-mutating.ts` (memory mutations) build proposal rows and return their ids. They never call provider methods or `db.memory.*` writes directly. The human still confirms via the chat UI before `confirmProposal` runs.
6. **Project sources are read-only for the agent.** The agent gets `list_sources` / `read_source` / `search_sources` only (`src/agent/tools/source.ts`). Source writes are human-driven through the sources router (`src/server/sources/router.ts`). Enforced by `src/__arch__/no-source-mutation-tools.test.ts`.
7. **LLM vendor SDKs stay quarantined to the adapter layer.** Only `src/agent/llm/openai.ts` (and any future vendor adapter) imports `openai` / Anthropic SDK / etc. The agent loop talks to a vendor-neutral interface so swapping providers doesn't ripple. Enforced by `src/__arch__/no-llm-vendor-leak.test.ts`.
8. **Octokit stays inside the GitHub provider.** Only `src/providers/github/**` may import `@octokit/*`. Same idea as the LLM rule, enforced by `src/__arch__/no-octokit-leak.test.ts`.
9. **Audit writes only from the proposal executor.** `db.audit.create(...)` is called from `src/server/proposals/executor.ts:recordAudit` and nowhere else, so confirmed/rejected proposals always produce one row of evidence and routers can't drift into ad-hoc audit logging. Enforced by `src/__arch__/no-audit-write-leak.test.ts`.
10. **Keep the prompt prefix byte-stable.** No timestamps, usernames, view labels, or other runtime-only text in the system+ticket-snapshot prefix or OpenAI's automatic prompt cache collapses. The prefix is built in `src/agent/prompt.ts` and passed through `src/agent/loop.ts`. Per-turn dynamic content (recent messages, tool results) lives *after* the prefix.
11. **Preserve agent tool registration order.** The ordered tool schema list is part of the prompt-cache key. Current order (`src/agent/tools/registry.ts:TOOL_ORDER`):
    1. readonly: items → PRs → commits/CI (`readonly.ts`)
    2. links (`links.ts`)
    3. memory readonly, project-scoped (`memory.ts`)
    4. source readonly, project-scoped (`source.ts`)
    5. MCP, project-scoped, dynamically populated (`@/agent/mcp/tools`) — stripped in read-only
    6. mutating provider tools (`mutating.ts`) — stripped in read-only
    7. memory mutations (`memory-mutating.ts`) — stripped in read-only
    8. out-of-band: `ask_user_question` (`question.ts`) — the loop dispatches it specially but it's still a registered tool
    9. `web_fetch` (`web-fetch.ts`) — read-only network tool, gated by per-project `web-fetch.enabled`. Pinned at the tail so toggling its presence doesn't shift any earlier tool's slot.

    Pinned by `src/__arch__/tool-registration-order.test.ts`. Reorder = invalidate every open conversation's prompt cache.
12. **Postgres `Item` rows are a cache, not the system of record.** Sync runs from the provider into Prisma (`src/server/sync/...`); confirmed writes refresh the cached row from the response inside `confirmProposal`.
13. **No hidden runtime singletons.** Pass `db`, `session`, `projectId`, `userId`, the resolved provider through tRPC context (`src/server/trpc.ts`) and per-request handles. The Prisma client is the one allowed module-level singleton (`src/server/db.ts`).
14. **Read-only mode blocks every mutation entry point and strips mutating tools.** The `app.read-only` global Setting flips system-wide. Every mutating procedure derives from `mutationProcedure` (`src/server/trpc.ts`), which runs `enforceReadWrite` to refuse with `FORBIDDEN`. The agent registry strips groups (5)–(7) when `readOnly` is true (`src/agent/tools/registry.ts:buildToolRegistry`).
15. **Project switches must rebuild the agent.** Tool closures bind to `(projectId, userId)` at registry-build time. Switching projects means building a fresh registry — not mutating an existing one — so a stale closure can't leak data across projects.
16. **Secrets at rest are AES-256-GCM-encrypted with `SECRETS_KEY`.** Wire format `enc:v1:<iv>:<ct+tag>`, implemented in `src/server/secrets/encryption.ts`. Plain-text rows from before encryption was wired remain readable; the next write re-encrypts them. Rotating `SECRETS_KEY` requires re-encrypting every row that uses it.

## tRPC Procedure Layers

`src/server/trpc.ts` exports a stack of progressively-stricter procedures. Pick the weakest one that fits — they compose left-to-right.

| Procedure | Adds |
| --- | --- |
| `publicProcedure` | None — anonymous-allowed. Use for genuinely public reads (currently only `health`). |
| `protectedProcedure` | Requires a NextAuth session. Default for authenticated reads. |
| `mutationProcedure` | `protectedProcedure` + `enforceReadWrite` (refuses if `app.read-only` is on). Use for all global mutations. |
| `projectScopedProcedure` | `protectedProcedure` + project-membership check. Inputs must include `projectId`. |
| `projectScopedMutationProcedure` | `projectScopedProcedure` + `enforceReadWrite`. The default for project-scoped mutations. |
| `projectScopedApproverProcedure` | `projectScopedMutationProcedure` + approver-role check. Confirm endpoints, destructive admin actions. |

## Mutation Surface Pattern

Every write — UI button, agent tool, raw HTTP — flows through the same shape: build a proposal, then dispatch via `confirmProposal`. The proposal table holds the state; the executor holds the only provider-write call site. Example from a tRPC mutation:

```ts
import { proposeTransition } from "@/server/proposals/builders";
import { confirmProposal } from "@/server/proposals/executor";

// 1. Stage — happens in the router or in an agent tool
const proposal = await proposeTransition(ctx.db, {
  projectId,
  userId: ctx.session.user.id,
  itemId,
  intent,
});

// 2. (UI renders the diff via proposalsRouter.get + diff.ts)

// 3. Confirm — the dedicated confirm endpoint dispatches the write
const result = await confirmProposal(
  { db: ctx.db, projectId, userId: ctx.session.user.id },
  proposal.id,
);
```

Available proposal builders in `src/server/proposals/builders.ts`: `proposeTransition`, `proposeDescriptionPatch`, `proposeComment`, `proposeTagsChange`, `proposeNewItem`, `proposeMemoryWrite`, `proposeMemoryDelete`. The executor dispatches each `kind` to the matching provider method (or to a memory writer for memory proposals) and refreshes the cached `Item` row from the response. Builders may also attach an `advisory` string ("comment echoes description", etc.) that the confirm dialog surfaces above the diff.

Surfaces:

- **UI:** `src/ui/proposals/...` renders the diff modal; the confirm button calls `proposals.confirm` via tRPC.
- **HTTP / tRPC:** `src/server/proposals/router.ts` exposes `list`, `get`, `confirm`, `reject`. The confirm path requires `projectScopedApproverProcedure`.
- **Agent:** `src/agent/tools/mutating.ts` and `src/agent/tools/memory-mutating.ts` stage proposals only; the user confirms in the chat UI exactly the same way they would for a UI-initiated change.

## Architecture Map

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
        |                                       suggestions, projects, health)
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

Forbidden edges (each one has a regex-scanning arch test under `src/__arch__/`):

- Routers → concrete provider modules (`no-router-provider-import.test.ts`)
- Anyone → provider write methods, except `proposals/executor.ts` (`no-provider-write-leak.test.ts`)
- Anyone → `db.audit.create`, except `proposals/executor.ts` (`no-audit-write-leak.test.ts`)
- Anyone → Octokit, except `src/providers/github/**` (`no-octokit-leak.test.ts`)
- Anyone → LLM vendor SDKs, except `src/agent/llm/**` (`no-llm-vendor-leak.test.ts`)
- Agent → source mutation paths (`no-source-mutation-tools.test.ts`)

Aspirational direction (consistent with current refactors, not a hard rule):

- Pages and tRPC routers stay thin — parse input, call one service, map result back. Business logic lives in `src/server/<feature>/` modules, not in route handlers.
- Provider onboarding centralizes in `src/server/provider-registry.ts` + the two builders. Adding a provider should not need a grep across surface code.
- Per-project admin (memory, sources, MCP fleet, saved views, default LLM) lives in shared services so server components and tRPC clients can't drift.

> **Adding a new provider?** See **[.docs/ADDING_A_PROVIDER.md](.docs/ADDING_A_PROVIDER.md)** for the full authoring walkthrough — package layout, the `WorkItemProvider` interface, `ProviderSpec` fields, NextAuth wiring via `auth-build.ts`, registration in `provider-registry.ts`, and the testing checklist.

## Global Invariants

- **Bootstrap is env-driven and idempotent.** `bin/seed-dev.ts` reads `DEV_OPENAI_API_KEY`, `DEV_GITHUB_CLIENT_ID`, `DEV_GITHUB_CLIENT_SECRET` and writes any missing `LlmProvider` / `OauthProviderConfig` rows. Once both an LLM provider and an OAuth provider exist, the `setup.complete` global Setting flips and the seed becomes a no-op forever after — admin UI edits are never stomped, even if env values change. The same script runs in dev (via `predev`) and in production (via `bin/docker-entrypoint.sh`).
- **`setup.complete` gates middleware.** Pre-completion, every authenticated route redirects to `/setup-required`. Post-completion, normal auth + project membership applies. There is no separate `/admin` surface — operator-level config lives under `/settings` (LLM providers, OAuth providers, members, MCP fleet, budget, audit log).
- **Read-only mode is system-wide.** `app.read-only` Setting → `enforceReadWrite` middleware refuses every mutation procedure → agent registry strips mutating tools. There is no per-user toggle and no per-route bypass.
- **Audit is append-only.** Every confirmed or rejected proposal produces one `Audit` row. Foreign keys to `User` use `onDelete: SetNull` so user deletion never cascade-erases the audit trail.
- **Watchlist rows live independently of `Item`.** Pinned ids may outlive the current cache scope (e.g. provider deleted the item).
- **Inbound external changes are injected into active conversations** as system messages so the assistant doesn't keep reasoning over stale ticket state (`src/server/inbound-changes/inject.ts`).
- **MCP server config is per-project**, persisted in the DB. Live agent registries are rebuilt on project switch — config edits do not auto-mutate a running registry.
- **Encrypted-at-rest fields on `LlmProvider.apiKey` and `OauthProviderConfig.clientSecret`** use `enc:v1:<iv>:<ct+tag>`. Reads transparently decrypt; writes always encrypt. Plain-text legacy rows remain readable until the next write.
- **Prisma client lives at `src/db/generated/`** (custom output dir, gitignored). Never import from `@prisma/client` — always from `@/db/generated/client`.
- **The seed script is bundled for production.** The Docker builder runs `bun build bin/seed-dev.ts --target=bun --conditions react-server --outfile bin/seed-dev.js` so the runtime image doesn't need the TS source tree. The `--conditions react-server` flag resolves the `server-only` marker package to its no-op shim instead of throwing on import.

## Testing

- **Layout by intent.** `src/__arch__/` for architectural guards (regex-scanning tests that fail CI on forbidden imports). Co-located `*.test.ts` files for unit/service tests next to the module they cover. Integration tests against a test Postgres go in `tests/` if the surface area grows.
- **Stack.** Vitest, with `bun run test` driving it. The arch tests are pure file-system scans — no DB, no fixtures. Service tests use Vitest mocking + a per-test Prisma transaction where touching the DB.
- **Architecture tests are not optional.** `src/__arch__/no-router-provider-import.test.ts`, `no-provider-write-leak.test.ts`, `no-audit-write-leak.test.ts`, `no-octokit-leak.test.ts`, `no-llm-vendor-leak.test.ts`, `no-source-mutation-tools.test.ts`, `tool-registration-order.test.ts`. If they fail, fix the leak — don't relax the test.
- **When you change agent tooling, prompt loading, or the proposal executor**, cover both the pure unit and at least one router-level path that exercises the same flow.

## Linting and Code Style

- **Biome** is the formatter and linter (`biome.json`). `bun run check` runs `biome check`, `tsc --noEmit`, then Vitest.
- **TypeScript strict** is on. New code carries real types — no `any` placeholders, no `// @ts-expect-error` without a justification comment.
- **Prefer editing existing files.** Default to no comments; only write a comment when the WHY is non-obvious (a hidden constraint, a workaround for a specific bug, an invariant a future reader would otherwise miss). Don't explain WHAT the code does — well-named identifiers already do that.
- **No `Co-Authored-By: Claude` trailers** on commit messages. No emojis in source unless the user requests them.

## When in doubt

- **Skim** `src/server/proposals/executor.ts` and `src/agent/tools/registry.ts` — they're the spine of the safety story.
- **Run** the architecture tests (`bun run test src/__arch__/`) before pushing a refactor.
- **Read** [README.md](README.md) for the user-facing tour and self-hosting walkthrough.
