# Docket — contract for human and AI contributors

This file is the load-bearing reference for anyone (or anything) editing the codebase. It captures invariants that aren't visible from a single grep — architecture rules enforced by tests, the proposal-first mutation pattern, and conventions the wider tooling depends on. Read it before making non-trivial changes.

## Project Snapshot

- **Next.js 16 App Router** + **tRPC v11** + **Prisma 7** + **Postgres 16** + **NextAuth v5**, running on **Node 22** with **pnpm 9**. One Node process serves the SSR pages (`src/app/`), the SPA-style React UI (`src/ui/`), the tRPC API at `/api/trpc/*` (`src/server/routers/`), and the SSE chat stream at `/api/projects/:id/conversations/:id/stream` (`src/app/api/`).
- **Layered ports-and-adapters.** Surfaces in `src/app/` and `src/ui/`. Canonical types in `src/core/`. Orchestration in `src/server/<feature>/` and `src/agent/`. Adapters in `src/providers/{github,azure-devops}/`, `src/server/secrets/`, `src/server/db.ts`, `src/server/logger.ts`.
- **Multi-provider.** Built-ins: `github`, `azure_devops`. Specs registered in `src/server/provider-registry.ts`; concrete instances built per-user via `src/server/providers/build.ts` (work-item) and `src/server/providers/auth-build.ts` (NextAuth sign-in).
- **Postgres-backed cache.** The provider stays the source of truth; `Item` rows in Postgres cache what the user has seen for instant filter/search. Memory, prompts, MCP server configs, settings, and the audit log all live in the same DB.
- **Project-scoped runtime.** One project per provider scope. Per-project: memory, sources, MCP fleet, default LLM, saved views.
- **Role-split LLM providers.** `LlmProvider` rows carry a `role` field (`chat` | `guardrail`). The agent loop picks the `chat` provider; the guardrail pipeline picks the `guardrail` provider, enabling a cheaper/faster model for safety checks without affecting the main chat model.
- Primary safety property: **proposal-first mutation**. Stage a `Proposal`, render a diff, require explicit confirmation before any provider write or memory mutation.
- **Recommendation contract.** Docket is a ticket recommendation engine, not a coding agent — it never branches, commits, or opens PRs. Four named recommendation modes (likely-resolved, incomplete-info, duplicate / related, short illustrative code examples) are project-toggleable under `recommendations.*` in the settings catalog. The `close_duplicate` `TransitionIntent` exists for the duplicate mode. A deterministic post-processor (`src/agent/post/code-snippet-cap.ts`) trims code blocks past the project's caps before assistant replies persist or staged comment / description bodies land in `Proposal` rows.
- **Cleaned-by-default `web_fetch`.** HTML responses pulled by the agent are stripped of head/script/style/noscript/iframe/svg + comments and converted to markdown via Turndown before reaching the model — saves context tokens and keeps inline assets out of reasoning. The agent can opt out per call with `raw: true`. Implementation in `src/agent/tools/web-fetch-clean.ts`; cleanup outcome (success / fallback reason / cleaned byte count) is recorded on each `WebFetchEvent`.

## Commands

```bash
corepack enable                         # one-time; activates the pinned pnpm version
pnpm install
cp .env.example .env.local              # at minimum: DATABASE_URL, AUTH_SECRET, plus DEV_* seeds
pnpm dev                                # predev: prisma db push --accept-data-loss + bin/apply-raw-sql.ts + bin/seed-dev.ts, then next dev (Turbopack)

pnpm build                              # next build
pnpm start                              # next start (production)
pnpm check                              # biome + tsc + vitest run
pnpm test                               # vitest run (full suite)
pnpm test:watch                         # vitest in watch mode

pnpm exec prisma migrate dev            # apply schema changes against your dev DB
pnpm exec prisma db push                # push the schema without producing a migration (dev/docker entrypoint)
pnpm exec prisma generate               # regenerate the client into src/db/generated/
pnpm exec prisma studio                 # browse the DB

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
3. **Provider write methods are called from exactly one place.** `src/server/proposals/executor.ts` (`confirmProposal`) is the sole caller of `.transition(`, `.patchDescription(`, `.uploadAttachment(`, `.addComment(`, `.createItem(`, `.setTags(`, `.addReaction(`, and `.removeReaction(`. Enforced by `src/__arch__/no-provider-write-leak.test.ts` — a regex scan that ignores the executor itself and the concrete provider implementations.
4. **Every write is proposal-first.** Build a `Proposal` row via `src/server/proposals/builders.ts`, render a diff via `src/server/proposals/diff.ts`, then dispatch through `confirmProposal`. The `proposalsRouter` (`src/server/proposals/router.ts`) is the only HTTP entry point for confirmation. UI-initiated, agent-initiated, and HTTP-initiated writes all share this path — there is no fast lane.
5. **Agent mutating tools only stage proposals.** `src/agent/tools/mutating.ts` (provider mutations) and `src/agent/tools/memory-mutating.ts` (memory mutations) build proposal rows and return their ids. They never call provider methods or `db.memory.*` writes directly. The human still confirms via the chat UI before `confirmProposal` runs.
6. **Project sources are read-only for the agent.** The agent gets `list_sources` / `read_source` / `search_sources` only (`src/agent/tools/source.ts`). Source writes are human-driven through the sources router (`src/server/sources/router.ts`). Enforced by `src/__arch__/no-source-mutation-tools.test.ts`.
7. **LLM vendor SDKs stay quarantined to the adapter layer.** Only the chat adapter (`src/agent/llm/openai.ts`) and the guardrail LLM-judge (`src/agent/guardrail/llm-judge.ts`) import `openai` / Anthropic SDK / etc.; future vendors land alongside them. The agent loop and the rest of the codebase talk to vendor-neutral interfaces so swapping providers doesn't ripple. Enforced by `src/__arch__/no-llm-vendor-leak.test.ts`.
8. **Octokit stays inside the GitHub provider.** Only `src/providers/github/**` may import `@octokit/*`. Same idea as the LLM rule, enforced by `src/__arch__/no-octokit-leak.test.ts`.
9. **Audit writes only from the proposal executor.** `db.audit.create(...)` is called from `src/server/proposals/executor.ts:recordAudit` and nowhere else, so confirmed/rejected proposals always produce one row of evidence and routers can't drift into ad-hoc audit logging. Enforced by `src/__arch__/no-audit-write-leak.test.ts`.
10. **Keep the prompt prefix byte-stable.** No timestamps, usernames, view labels, or other runtime-only text in the system+ticket-snapshot prefix. OpenAI's prompt cache (the only adapter wired today) hashes the request prefix automatically and collapses on the slightest drift. Other vendors take different shapes — Anthropic uses explicit `cache_control` breakpoints, Bedrock has its own — but byte-stability is the broadest precondition: every cache mechanism we've seen rewards it, none penalize it. The prefix is built in `src/agent/prompt.ts` and passed through `src/agent/loop.ts`. Per-turn dynamic content (recent messages, tool results) lives *after* the prefix.
11. **Preserve agent tool registration order.** The ordered tool schema list is part of the prompt-cache key. Current order (`src/agent/tools/registry.ts:TOOL_ORDER`):
    1. readonly: items → PRs → commits/CI (`readonly.ts`)
    2. links (`links.ts`)
    3. memory readonly, project-scoped (`memory.ts`)
    4. source readonly, project-scoped (`source.ts`)
    5. MCP, project-scoped, dynamically populated (`@/agent/mcp/tools`) — stripped in read-only
    6. mutating provider tools (`mutating.ts`) — stripped in read-only. Order: `propose_transition`, `propose_description_patch`, `propose_comment`, `propose_new_item`, `propose_item_tags`. Reactions are intentionally UI-only (no agent tool) — they're conversational signals between humans, not work the agent should be doing.
    7. memory mutations (`memory-mutating.ts`) — stripped in read-only
    8. out-of-band: `ask_user_question` (`question.ts`) — the loop dispatches it specially but it's still a registered tool
    9. `web_fetch` (`web-fetch.ts`) — read-only network tool, gated by per-project `web-fetch.enabled`. HTML responses are converted to cleaned markdown by default (head/script/style/comments stripped, relative links resolved); the agent can pass `raw: true` to skip cleaning when the cleaned output looks wrong. Cleaning lives in `web-fetch-clean.ts` (jsdom + Turndown). Pinned after `ask_user_question` so toggling its presence doesn't shift any earlier tool's slot.
    10. discovery (`discovery.ts`) — read-only tools added after the original cohort (`search_items`, `list_audit_log`, `get_pull_request_diff`, `search_code`, `search_pull_requests`). Pinned at the tail so introducing more later doesn't shift any earlier tool's slot.

    Pinned by `src/__arch__/tool-registration-order.test.ts`. Reorder = invalidate every open conversation's prompt cache.
12. **Postgres `Item` rows are a cache, not the system of record.** Sync runs from the provider into Prisma (`src/server/sync/...`); confirmed writes refresh the cached row from the response inside `confirmProposal`.
13. **No hidden runtime singletons.** Pass `db`, `session`, `projectId`, `userId`, the resolved provider through tRPC context (`src/server/trpc.ts`) and per-request handles. Two deliberate, `globalThis`-stashed exceptions: the Prisma client (`src/server/db.ts`) and the server-side sync scheduler (`src/server/sync/scheduler.ts`). Both are out-of-band by design — neither is consulted from request handlers as state — and both stash on `globalThis` so Next.js HMR doesn't leak duplicates. The scheduler runs one incremental sync per project on the cadence configured by the project's `sync.interval-seconds` setting; it replaces the per-tab client polling that used to live in `useBackgroundSync`.
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

Available proposal builders in `src/server/proposals/builders.ts`: `proposeTransition`, `proposeDescriptionPatch`, `proposeComment`, `proposeTagsChange`, `proposeAssigneeChange`, `proposeReactionToggle`, `proposeNewItem`, `proposeMemoryWrite`, `proposeMemoryDelete`. The executor dispatches each `kind` to the matching provider method (or to a memory writer for memory proposals) and refreshes the cached `Item` row from the response. Builders may also attach an `advisory` string ("comment echoes description", etc.) that the confirm dialog surfaces above the diff.

**Origin-aware auto-confirm.** Every proposal carries an `origin` field (`"ui"` | `"agent"`) stamped at stage time. `maybeAutoAccept` (`src/server/proposals/executor.ts`) auto-confirms UI-origin rows on two paths: (1) the architectural **floor** — `comment_add`, `reaction_toggle`, `tags_change`, `assignee_change`, and `description_patch` always auto-confirm from the UI, no policy lookup (`AUTO_ACCEPT_FLOOR_KINDS` in `src/server/settings/catalog.ts`). The floor covers edits the user already performed in the UI — re-asking for confirmation in a dialog would just rubber-stamp what they already clicked. (2) **extras** — kinds the project explicitly opted into via `proposals.auto-accept-extra-kinds`, restricted to local-DB kinds (`memory_write`, `memory_delete`). Provider-touching kinds beyond the floor (state changes, new items) always require explicit human review. Agent-staged proposals always wait for human confirmation regardless of either path — `confirmProposal` itself refuses `source: "auto"` on a non-`ui` row as defense in depth. Read-only mode wins on both paths.

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
        |                                       views, settings, setup, llmProviders,
        |                                       oauthProviders, watchlist, suggestions,
        |                                       projects, analytics, health)
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
- Anyone → concrete `next-auth/providers/<name>` imports, except `src/server/providers/auth-build.ts` and `src/providers/<x>/**` (`no-nextauth-provider-leak.test.ts`)
- Agent → source mutation paths (`no-source-mutation-tools.test.ts`)
- Every `LLM_KINDS` entry must have a `case` in the registry dispatch (`llm-kinds-have-adapters.test.ts`)

Aspirational direction (consistent with current refactors, not a hard rule):

- Pages and tRPC routers stay thin — parse input, call one service, map result back. Business logic lives in `src/server/<feature>/` modules, not in route handlers.
- Provider onboarding centralizes in `src/server/provider-registry.ts` + the two builders. Adding a provider should not need a grep across surface code.
- Per-project admin (memory, sources, MCP fleet, saved views, default LLM) lives in shared services so server components and tRPC clients can't drift.

> **Adding a new provider?** See **[docs/ADDING_A_PROVIDER.md](docs/ADDING_A_PROVIDER.md)** for the full authoring walkthrough — package layout, the `WorkItemProvider` interface, `ProviderSpec` fields, NextAuth wiring via `auth-build.ts`, registration in `provider-registry.ts`, and the testing checklist.
>
> **Adding a new LLM vendor?** See **[docs/ADDING_AN_LLM.md](docs/ADDING_AN_LLM.md)** for the adapter walkthrough — `LlmAdapter` interface, the SDK quarantine enforced by `no-llm-vendor-leak.test.ts`, `LLM_KINDS` registration, the chat/guardrail role split, and the testing checklist.

## Global Invariants

- **Bootstrap is env-driven and idempotent.** `bin/seed-dev.ts` reads `DEV_OPENAI_API_KEY` (plus optional `DEV_OPENAI_MODEL` / `DEV_OPENAI_BASE_URL` / `DEV_OPENAI_INPUT_PRICE_CENTS_PER_MTOK` / `DEV_OPENAI_OUTPUT_PRICE_CENTS_PER_MTOK`), `DEV_GITHUB_CLIENT_ID` + `DEV_GITHUB_CLIENT_SECRET`, and `DEV_AZURE_DEVOPS_CLIENT_ID` + `DEV_AZURE_DEVOPS_CLIENT_SECRET` (+ optional `DEV_AZURE_DEVOPS_TENANT_ID`), and writes any missing `LlmProvider` / `OauthProviderConfig` rows. Once both an LLM provider and an OAuth provider exist, the `setup.complete` global Setting flips and the seed becomes a no-op forever after — admin UI edits are never stomped, even if env values change. The same script runs in dev (via `predev`, after `prisma db push` and `bin/apply-raw-sql.ts`) and in production (via `bin/docker-entrypoint.sh`, also after `prisma db push` and `bin/apply-raw-sql.mjs`).
- **Raw-SQL post-push bootstrap.** `bin/apply-raw-sql.ts` (run between `prisma db push` and the seed in both dev and Docker) installs the `pg_trgm` extension, three partial unique indexes on `Setting` for global / user / project scopes (Postgres treats NULL as distinct in plain uniques, so `@@unique([key, userId, projectId])` was a no-op for the partial-NULL scopes), and GIN trgm indexes on `Item.title` / `Item.description` that back the ILIKE search the items router and the agent's `search_items` tool both rely on. Idempotent; missing env or unavailable DB just logs a warning and exits 0.
- **`setup.complete` gates middleware.** Pre-completion, every authenticated route redirects to `/setup-required`. Post-completion, normal auth + project membership applies. There is no separate `/admin` surface — operator-level config lives under `/settings` (LLM providers, OAuth providers, members, MCP fleet, budget, audit log).
- **Read-only mode is system-wide.** `app.read-only` Setting → `enforceReadWrite` middleware refuses every mutation procedure → agent registry strips mutating tools. There is no per-user toggle and no per-route bypass.
- **Audit is append-only.** Every confirmed or rejected proposal produces one `Audit` row. Foreign keys to `User` use `onDelete: SetNull` so user deletion never cascade-erases the audit trail.
- **Watchlist rows live independently of `Item`.** Pinned ids may outlive the current cache scope (e.g. provider deleted the item).
- **Inbound external changes are injected into active conversations** as system messages so the assistant doesn't keep reasoning over stale ticket state (`src/server/inbound-changes/inject.ts`).
- **MCP server config is per-project**, persisted in the DB. Live agent registries are rebuilt on project switch — config edits do not auto-mutate a running registry.
- **Guardrail is pluggable and runs on every turn.** Kinds: `noop`, `pattern`, `llm-judge`, `composite`. The `llm-judge` kind uses the `guardrail`-role `LlmProvider` row (`src/agent/guardrail/llm-judge.ts`). Toggles: prompt-injection blocking, off-topic detection, scope check, output check. If `llm-judge` is configured but no matching provider row resolves, the pipeline falls back to `pattern`. LLM vendor SDK for the judge is quarantined to `src/agent/guardrail/llm-judge.ts`, which is one of the two allowed importers in `no-llm-vendor-leak.test.ts`.
- **Encrypted-at-rest fields on `LlmProvider.apiKey` and `OauthProviderConfig.clientSecret`** use `enc:v1:<iv>:<ct+tag>`. Reads transparently decrypt; writes always encrypt. Plain-text legacy rows remain readable until the next write.
- **Prisma client lives at `src/db/generated/`** (custom output dir, gitignored). Never import from `@prisma/client` — always from `@/db/generated/client`.
- **Bootstrap scripts are bundled for production.** The Docker builder runs `pnpm exec esbuild bin/seed-dev.ts ... --outfile=bin/seed-dev.mjs` and `pnpm exec esbuild bin/apply-raw-sql.ts ... --outfile=bin/apply-raw-sql.mjs` (both `--bundle --platform=node --target=node22 --format=esm --conditions=react-server`, both with a `createRequire` banner so bundled CJS deps still resolve `require()`) so the runtime image doesn't need the TS source tree. The `--conditions=react-server` flag resolves the `server-only` marker package to its no-op shim instead of throwing on import. `bin/docker-entrypoint.sh` runs `prisma db push --accept-data-loss`, then `apply-raw-sql.mjs`, then `seed-dev.mjs` before `exec`-ing CMD. In dev the same scripts run via `tsx --conditions=react-server` (no build step).

## Testing

- **Layout by intent.** `src/__arch__/` for architectural guards (regex-scanning tests that fail CI on forbidden imports). Co-located `*.test.ts` files for unit/service tests next to the module they cover. Integration tests against a test Postgres go in `tests/` if the surface area grows.
- **Stack.** Vitest, with `pnpm test` driving it. The arch tests are pure file-system scans — no DB, no fixtures. Service tests use Vitest mocking + a per-test Prisma transaction where touching the DB.
- **Architecture tests are not optional.** `src/__arch__/no-router-provider-import.test.ts`, `no-provider-write-leak.test.ts`, `no-audit-write-leak.test.ts`, `no-octokit-leak.test.ts`, `no-llm-vendor-leak.test.ts`, `no-nextauth-provider-leak.test.ts`, `no-source-mutation-tools.test.ts`, `tool-registration-order.test.ts`, `llm-kinds-have-adapters.test.ts`, `core-stays-provider-agnostic.test.ts` (nothing under `src/core/` may reference concrete providers or vendor SDKs), `guardrail-scan-coverage.test.ts` (every registered agent tool declares a `guardrailScan` classification), `provider-creatable-kinds.test.ts` (every registered `ProviderSpec` declares a non-empty `capabilities.creatableKinds` whose entries are all canonical `ItemKind` values — the "+ New item" form takes its dropdown from this list). If they fail, fix the leak — don't relax the test.
- **When you change agent tooling, prompt loading, or the proposal executor**, cover both the pure unit and at least one router-level path that exercises the same flow.

## Linting and Code Style

- **Biome** is the formatter and linter (`biome.json`). `pnpm check` runs `biome check`, `tsc --noEmit`, then Vitest.
- **TypeScript strict** is on. New code carries real types — no `any` placeholders, no `// @ts-expect-error` without a justification comment.
- **Prefer editing existing files.** Default to no comments; only write a comment when the WHY is non-obvious (a hidden constraint, a workaround for a specific bug, an invariant a future reader would otherwise miss). Don't explain WHAT the code does — well-named identifiers already do that.
- **No `Co-Authored-By: Claude` trailers** on commit messages. No emojis in source unless the user requests them.
- **`src/app/globals.css` is paste-only territory.** It must match the exact shape tweakcn (or any other shadcn theme generator) emits — `@import "tailwindcss"`, `@custom-variant dark`, `:root` / `.dark` token blocks, `@theme inline`, and the base `@layer`. UI code only references tokens defined in this file (palette + chart slots) — there is no second token source. Webfont loaders and small custom utilities go in `src/app/app.css`, which `layout.tsx` imports right after `globals.css`. After pasting a new theme, double-check `--font-sans` / `--font-mono` family names still match what `app.css`'s Google Fonts URL loads.

## When in doubt

- **Skim** `src/server/proposals/executor.ts` and `src/agent/tools/registry.ts` — they're the spine of the safety story.
- **Run** the architecture tests (`pnpm test src/__arch__/`) before pushing a refactor.
- **Read** [README.md](README.md) for the user-facing tour and self-hosting walkthrough.
