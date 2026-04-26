# T3-stack migration — implementation plan

**Status:** plan, not yet started. Greenlit only when a trigger condition fires (see end of doc). Until then this is the canonical reference for *how* the migration runs when it does.

The whole rewrite happens on a single long-lived branch, **`feature/t3-migration`**, with one push per completed phase. No PRs (solo, main-only repo); the branch merges back into `main` only after Phase 10's acceptance gates pass.

## Scope of this plan

This is a **complete rewrite**, not a port. Every backend capability currently in `src/docket/` is either reproduced in TypeScript or explicitly dropped with a recorded reason. The Python tree on `main` is the reference during the rewrite; the feature branch wipes `src/docket/` and `frontend/` at Phase 0 and grows the new tree from scratch.

Non-negotiable goals:

- **Functional parity** for every backend behavior listed in the migration map below — except the entries marked **DROPPED**.
- **Provider-agnostic core.** The architectural invariant from `CLAUDE.md` rule 1 carries over: nothing in `core/`, `db/`, `agent/`, `server/` (the new equivalents) imports a concrete provider module.
- **No TUI.** Already accepted. Anything TUI-shaped becomes a web flow.
- **One stack.** TS everywhere. No Python in the final tree. No FastAPI/Vite split. No OpenAPI codegen.
- **One process.** Next.js serves the SPA and the tRPC API from a single deployment.
- **Simpler than today.** Every phase ends with a deletion/dedup/rename pass. The final tree should be smaller and flatter than `src/docket/`, not bigger.

## Pre-conditions before Phase 0

Don't start until **all** of these are true:

- A trigger condition from `Trigger conditions` (end of doc) has fired.
- A deployment shape is chosen. **Default: docker-compose self-host** (see Phase 11). Vercel / Fly / Render remain compatible — the same `Dockerfile` and the same first-run wizard work in both shapes.
- A Postgres provider is decided: bundled in docker-compose (default) or managed (Neon / Supabase / Railway) for cloud deploys.
- GitHub OAuth App registered. **Note:** the client ID / secret are entered through the first-run wizard (Phase 11) at deploy time — not into a `.env` during development. For local dev pre-Phase-11, a `.env.local` is acceptable scaffolding.
- The simplification roadmap (`project_simplification_roadmap`) is paused — no point cleaning code that's about to be deleted.

## Target stack and tooling

| Concern | Choice |
|---|---|
| Framework | Next.js 15 App Router |
| API layer | tRPC v11 (no REST, no OpenAPI) |
| ORM | Prisma + Postgres |
| Auth | NextAuth (Auth.js) v5 |
| Agent | LLM adapter interface; **only OpenAI (`openai`) ships in the initial cut** (GPT-5 is our daily driver), but the agent loop is fully LLM-agnostic — adding Anthropic / Gemini / Bedrock / Mistral / Ollama later is one new file in `src/agent/llm/` plus a registry entry, no core changes. See "LLM adapter — built provider-agnostic, OpenAI-only at launch" below. |
| UI | Tailwind v4 + shadcn/ui + react-hook-form + react-query (already on tRPC's recommended stack) |
| Routing UI state | tRPC + react-query (drop `@tanstack/react-router` — Next.js owns routing) |
| Streaming | Next.js route handlers w/ ReadableStream for SSE-equivalent agent chat |
| Tests | Vitest (unit + integration), Playwright (E2E for the proposal-first flow) |
| Lint/format | Biome (already in use in `frontend/`) — extends to the whole tree |
| Tooling | **bun** for install/dev/build/test. Fall back to npm only if a specific package refuses (record any such fallback in the per-phase notes) |
| Deploy | **docker-compose self-host** is the canonical target (Phase 11). Vercel / Fly remain compatible if someone wants managed; both Phase 11 and the cloud paths share the same first-run wizard |

Single repo layout on the feature branch:

```
docket/
  app/                   # Next.js App Router pages + API handlers
  src/
    core/                # canonical types, provider interface, proposal types
    db/                  # Prisma schema + generated client + thin query helpers
    providers/           # provider adapters (github, azure-devops); no stub
    server/              # tRPC routers, auth, agent orchestration
    agent/               # prompt loader, tool registry, loop, mcp client
    ui/                  # shared client components + shadcn primitives
  prisma/
    schema.prisma
    migrations/
  tests/
  package.json
  biome.json
  tsconfig.json
```

No more `apps/` / `packages/` monorepo split — single package, single tsconfig. Workspaces only get added if a real second deployable surface appears.

## Latest-version policy

Every package added during the migration is pinned to its **latest stable** at the moment it's added. The version table above records intent, not literal pins — confirm the actual current version online at install time.

- Before each phase's first `bun add`, query the npm registry for each package: `bun pm view <name> version` (or the npm web UI / `npm view <name> version`). Record the resolved version in the phase's commit message.
- Reject pre-release tags (`*-rc.*`, `*-beta.*`, `*-alpha.*`, `*-canary.*`) unless the package has no stable channel. For `next`, `react`, `prisma`, `next-auth`, `@anthropic-ai/sdk`, `openai`, `@trpc/*`, `zod`, `tailwindcss`, `@tanstack/react-query`, `@biomejs/biome`, `@modelcontextprotocol/sdk` — stable only.
- After each phase ships, run `bun outdated` and bump anything that drifted within the same major. The rename-and-dedup pass at the end of each phase includes this version-bump pass.
- If a package's latest stable forces a code change (breaking API), do the change in the same phase that introduced it — don't ship pinned to an older version with a `// TODO: bump` comment.
- The lockfile (`bun.lockb`) is committed; never bypass it with `--no-save`.
- For Node and bun runtime versions: pin to the latest LTS Node and the latest stable bun in `package.json#engines`. Re-check on every push that adds dependencies.

This rule is non-negotiable: a migration that ships on yesterday's stack defeats the point.

## LLM adapter — built provider-agnostic, OpenAI-only at launch

We ship **one** LLM implementation in the initial cut — OpenAI, because GPT-5 is what we run day-to-day. But we treat that as an instance of a general adapter, not as the agent's worldview. The whole loop, prompt loader, tool registry, and proposal pipeline are written against an interface; OpenAI is the first file that satisfies it.

**Why OpenAI for the launch implementation:**

- **Operational familiarity.** GPT-5 is our daily driver. Migration is the wrong time to also switch the primary model — keep that variable fixed.
- **Structured outputs.** OpenAI's Responses API has the strongest first-class structured-output ergonomics (JSON Schema enforced server-side, strict mode). Useful for proposal validation, tool-result coercion, suggestion ranking.
- **Prompt-cache property still holds.** OpenAI applies automatic prompt caching to deterministic prefixes ≥1024 tokens. The byte-stable prefix invariant (CLAUDE.md rule 7 / invariant 7 below) keeps paying off without any explicit cache markers in the request.
- **Cost knobs.** GPT-5 / mini / nano tiers let projects pick a cost point without changing vendor.

**Why we still build it provider-agnostic:**

- Future-us will want Anthropic, Gemini, Bedrock, Mistral, or local Ollama (OpenAI-compatible endpoint) at some point. Building the seam now is cheap — retrofitting one onto a hard-coded `openai`-everywhere agent later is expensive.
- The `LlmProvider` admin UI (Phase 11) already supports many rows of many `kind`s. The data model is multi-vendor from day one; only the *runtime adapter set* is one entry today.
- Architecture tests stay honest: nothing outside `src/agent/llm/` may import `openai`. The same rule will keep `anthropic`, `@google/genai`, etc. quarantined when they land.

**The seam.** `src/agent/llm/types.ts` defines exactly the surface the loop needs:

```ts
interface LlmAdapter {
  readonly kind: LlmKind; // 'openai' | 'anthropic' | 'gemini' | ...
  streamMessages(req: LlmRequest): AsyncIterable<LlmEvent>;
  formatToolResult(toolUseId: string, result: unknown): LlmToolResult;
  // ...minimal — keep this small
}
```

`LlmRequest` and `LlmEvent` are vendor-neutral discriminated unions. The agent loop never imports a vendor SDK directly; it only sees `LlmAdapter` values handed in by `selectAdapterFor(project)`.

**At launch (Phase 6):**

- `src/agent/llm/types.ts` — interface + neutral types.
- `src/agent/llm/openai.ts` — the one shipping adapter. Uses `openai`'s Responses API (verify latest stable at install time per the latest-version policy).
- `src/agent/llm/registry.ts` — `selectAdapterFor(project)` reads `LlmProvider.kind` and dispatches. Today the dispatch table has one entry; the switch statement covers `'openai'` and `default: throw new Error(...)`.
- Architecture test: only `src/agent/llm/openai.ts` imports `openai`.
- Tests use a fake adapter (`tests/fakes/llm.ts`), not the OpenAI SDK — same property the Python tree's `tests/fakes/llm.py` exercises today. This proves the seam is real, not theoretical.

**Adding a future provider** (post-launch, anytime, no migration needed):

1. New file `src/agent/llm/<vendor>.ts` implementing `LlmAdapter`.
2. Add the `kind` to the `LlmKind` union and the registry switch.
3. Add a wizard sub-page (or just a generic "add LLM provider → pick kind" form once the kinds list is long enough — see "Generic adapter UX" below).
4. Add the SDK to `package.json` (latest stable, per the version policy).
5. Architecture test re-runs and passes.

No agent code, no prompt code, no tool code, no proposal code touches the change.

**Generic adapter UX.** The first time we add a second adapter, the wizard's per-vendor pages collapse into one generic "add LLM provider" form: pick `kind`, enter API key, optional `baseUrl` (for Ollama / Azure OpenAI / proxies), optional model preference. The data model already supports this; the UI just hasn't needed it yet.

**LLM switcher in the chat pane.** Even though only OpenAI ships at launch, the chat pane includes an **LLM switcher** dropdown in its header from day one. Today it shows a single entry (the project's default OpenAI provider row, labeled e.g. `OpenAI · GPT-5`); tomorrow, when more adapters land or the admin adds more `LlmProvider` rows, the same dropdown lists them all without UI changes. This makes the multi-LLM intent visible in the product, and it forces us to wire the per-conversation LLM override (Phase 9 backend work surfaced earlier in the UI) at the right layer instead of bolting it on later. The switcher stays disabled (single option, non-interactive) until there's a real choice to make — but the affordance is in place.

**Tool-use shape note.** OpenAI's function-calling and (eventually) Anthropic's `tool_use` / `tool_result` blocks and Gemini's function-calling are all isomorphic but spelled differently. Each adapter normalizes to the loop's internal `LlmEvent` discriminated union; the agent loop, prompt loader, and tool registry never branch on vendor.

`Project.defaultLlmProviderId` (Phase 2) selects which `LlmProvider` row's adapter handles a project's chats. Per-conversation override possible later (Phase 9 settings).

## Multi-project model

Multi-project is **first-class**, not bolt-on. It carries the spirit of CLAUDE.md rule 13 — provider/project switches must rebuild the agent — into the new tree:

- A **project** is `(providerKind, providerScope, displayName, ownerUserId)` — e.g., "ACME Corp's `acme/web` GitHub repo," "Contoso's AzDO `Contoso/Platform` project."
- One user owns many projects (`ProjectMembership` Phase 2).
- Switching projects is a route param: `/projects/[projectId]/...`. Server reads `projectId` from the URL, derives `providerKey` and the LLM adapter from the row.
- Importing a project: from the dashboard, "Add project" → pick provider (any configured OAuth provider) → pick scope (org/repo for GitHub, organization/project for AzDO) → name → save.
- The agent's tool closures rebind on project switch — same property as today, just driven by the URL instead of in-process state.
- Architecture test: no module-level cache keyed by `projectId` outside `src/server/context.ts`.

UX targets:

- Project switcher in the shell (top bar). Shows current project + dropdown to switch.
- "Add project" CTA visible whenever the user has at least one OAuth provider connected.
- Cross-project navigation preserves chat scroll position per project (per-project conversation tab persisted in Postgres).

## Architectural invariants that carry over

These are the load-bearing rules from today's `CLAUDE.md`. Each is reproduced in the new tree at the layer named.

1. **No concrete-provider imports outside `src/providers/`.** Enforced by an ESLint rule (or a Vitest architecture test) on the new tree, mirroring `tests/unit/test_import_boundary.py`.
2. **Translate provider-native types at the boundary.** Per-provider `state-map.ts` files. Canonical enums live in `src/core/types.ts`.
3. **All provider writes route through the mutation service.** No tRPC router calls `octokit.issues.update` directly.
4. **Every write is proposal-first.** `proposals.create` (stages) → diff render in a shadcn dialog → `proposals.confirm` (executes). No "execute without proposal" path exists.
5. **Agent mutating tools only stage proposals.** Same rule as today.
6. **Project sources are read-only for the agent.** Same rule.
7. **Prompt prefix byte-stable.** No timestamps, usernames, or runtime-only strings before the cache boundary. Tool registration order pinned by an architecture test.
8. **Read-only mode strips mutating procedures and mutating agent tools.** Enforced at both the tRPC procedure factory (a `mutationProcedure` helper that errors when the session role is `viewer`) and the agent tool registry.
9. **Postgres is a cache for items, system-of-record for everything user-generated** (memory, sources, conversations, proposals, watchlist, settings). Cache rows refresh on confirmed write.
10. **No hidden runtime singletons.** Per-request context (`session`, `db`, `provider`, `projectId`) flows through tRPC `ctx`. No module-level mutable state.

## Simplification audit — question before you port

Do this audit at the start of each phase. If something on this list maps to that phase, drop or consolidate it instead of porting it.

### Frontend audit (existing `frontend/src/` — what to drop, fold, or reshape)

The existing SPA is the second-largest body of code after the Python tree. Most of it is going to be rewritten in `app/` + `src/ui/`, but the *patterns* matter — they should not be carried forward unexamined.

- **`frontend/src/api/schema.d.ts`** (5,416 LOC) and **`frontend/src/api/hooks.ts`** (854 LOC): generated OpenAPI types + hand-rolled react-query hook layer. **Both deleted.** tRPC's `@trpc/react-query` integration replaces them; types flow from server router definitions.
- **`frontend/src/api/client.ts`** + **`keys.ts`**: react-query client + key factories. Deleted; tRPC ships both.
- **`frontend/src/routeTree.gen.ts`** + **`router.tsx`** + **`routes/`**: TanStack Router. Deleted — Next.js App Router owns routing. Routes become `app/<segment>/page.tsx`.
- **`components/setup/`** (9 files: `WelcomeStep`, `CliStep`, `LlmStep`, `ProviderStep`, `ScopeStep`, `SettingsStep`, `ReviewStep`, `DoneStep`, `SetupWizard` + `connection/`): the entire wizard reflects today's bootstrap-token + `gh`/`az` CLI probing onboarding. **Delete all of it.** Replace with two screens: NextAuth sign-in, then a single "pick a project" form. The first-run admin wizard (Phase 11) is its own surface and lives outside `components/`.
- **`components/settings/_constants.ts` / `_helpers.ts` / `_shared.tsx` / `_types.ts`**: Python-style underscore-prefix files used as folder-private. **Drop the convention** (rule already in naming conventions). Inline or re-home each file by purpose.
- **`components/common/Modal.tsx`** + ad-hoc dialog wrappers: replaced by shadcn's `<Dialog>` primitive.
- **`components/common/FormField.tsx`** + **`FormInputs.tsx`** + **`lib/formClasses.ts`**: three competing form helpers. Pick one (shadcn's `<Form>` on top of react-hook-form). Delete the other two.
- **`components/common/AppShell.tsx`** vs **`components/shell/ItemsShellLayout.tsx`** + **`TopBar.tsx`** + **`StatusFooter.tsx`**: shell composed across two folders. Fuse into `src/ui/shell/`.
- **`components/chat/ChatPaneContext.tsx`** + **`useChatStream.ts`** + **`chatStreamReducer.ts`** + **`ChatPane.tsx`**: useReducer-based streaming pipeline. Reducer logic survives in spirit, but the chat surface should be expressible as one component reading a tRPC streaming subscription + react-query mutation; the explicit Context provider is unnecessary.
- **`components/detail/Markdown.tsx`** + **`hljsTheme.ts`** + **`rehypeHljs.ts`** + **`lib/cmTheme.ts`** + **`lib/theme.ts`**: hand-rolled markdown rendering, two custom theme stacks (codemirror + highlight.js + app theme). Audit whether the customization is still needed against shadcn's typography plugin + `react-markdown`. Default position: keep custom rendering only for the diff modal; everywhere else use vanilla `react-markdown` + the Tailwind typography plugin.
- **`components/items/newItemHelpers.ts`** + **`mcp/mcpServerDraft.ts`** + **`memory/memoryDraft.ts`** + **`sources/sourceDraft.ts`**: four "draft state for a form" helpers, each its own micro-pattern. With `react-hook-form` + Zod the draft concept disappears. Delete all four.
- **`components/items/ProposalConfirmFooter.tsx`** + **`components/mutations/ProposalCard.tsx`** + **`useLocalProposals.ts`**: proposal UI split across two folders. Fuse into `src/ui/proposals/` co-located with the proposal router on the server side via shared types.
- **`components/detail/PinButton.tsx`** + any remaining `pin*` references: rename to **`watchlist`** end-to-end.
- **`lib/staleness.ts`** + **`staleness.test.ts`** + **`components/items/ItemFreshness.tsx`**: staleness logic split across `lib/` and `components/`. Co-locate; tests next to source.
- **`lib/uiPrefs.ts`**: localStorage-backed UI preferences. In hosted, persist to a `Setting` row keyed by `userId`. Drop the localStorage path.
- **`lib/env.ts`**: reads `import.meta.env`. Replaced by Next.js's `process.env` + `env.mjs` (T3's standard `@t3-oss/env-nextjs` helper).
- **`lib/platform.ts`** + **`lib/issueLinks.ts`**: keep — but trim `platform.ts` to the minimum needed for keyboard-shortcut hint rendering.
- **`lib/cn.ts`**: keep — same `clsx` + `tailwind-merge` helper survives.
- **`components/common/CommandPalette.tsx`** (451 LOC): the largest single component. Audit during port — likely splittable into a host + a registry of command groups, each registered by the route that owns it.
- **`components/items/ItemsList.tsx`** (451 LOC) + **`components/sources/SourcesPage.tsx`** (464 LOC) + **`components/memory/MemoryPage.tsx`** (446 LOC): each is one giant file mixing fetch, list, filters, modals. During port: split into `<List>` + `<ListItem>` + `<Filters>` + `<DetailDrawer>` per page. The aim is no client component above ~200 LOC.

The new tree's shape:

```
app/                       # Next.js routes (page + layout files only — no logic)
  layout.tsx
  page.tsx                 # dashboard
  items/page.tsx
  items/[id]/page.tsx
  memory/page.tsx
  sources/page.tsx
  mcp/page.tsx
  settings/page.tsx
  admin/setup/page.tsx     # first-run wizard (Phase 11)
src/ui/
  shell/                   # AppShell, TopBar, StatusFooter, ProviderSwitcher
  items/                   # List, ListItem, Filters, Detail, NewItemForm
  detail/                  # ItemDetail, Markdown (only the diff-modal customization)
  chat/                    # ChatPane, QuestionCard
  proposals/               # ProposalCard, ConfirmDialog
  memory/                  # MemoryPage, MemoryCard
  sources/                 # SourcesPage, SourceCard
  mcp/                     # McpPage, ServerForm
  settings/                # SettingsPage + sections
  command-palette/         # Host + per-route command registries
  primitives/              # shadcn-generated: button, dialog, form, input, ...
src/lib/                   # cn, format, issue-links, platform (trimmed)
```

No `components/common/_shared` / `_helpers` / `_constants` files. No leading-underscore filenames. No `Pin*` identifiers anywhere. No drafts modules.

### Drop entirely (do not port)

- **`src/docket/cli/`** — Typer CLI. No replacement.
- **`src/docket/cli/tui/`** — Textual TUI. No replacement.
- **`src/docket/config/paths.py`** — XDG path resolution. State lives in Postgres.
- **`src/docket/config/secrets.py` + the keyring dependency** — secrets are encrypted at rest in Postgres or fetched from the platform's secret store.
- **`src/docket/config/setup_wizard.py`** (657 LOC) — multi-stage CLI/SPA setup. Replaced by NextAuth's first-login OAuth flow + a single "pick a project" form.
- **`src/docket/config/setup_discovery.py` + `src/docket/config/setup_hooks.py` + `src/docket/config/setup_utils.py` + `src/docket/api/_provider_setup.py`** — DTO assembly for the wizard's pickers. The OAuth flow lets us call provider APIs directly with the user's token; no `gh` / `az` shimming needed.
- **`src/docket/api/app.py:create_bootstrap_app` + the `window.__DOCKET_TOKEN__` injection** — auth gate is replaced by NextAuth session. The "two FastAPI apps" pattern disappears.
- **`src/docket/providers/github_stub/`** — runtime stub provider. Replaced by MSW or vi mocks at the test layer only. No stub provider ships in production.
- **`src/docket/telemetry/logging.py`** — rotating file logger. Replaced by structured logs to stdout (Pino).
- **`src/docket/config/mcp_presets.py`** — preset list lives in a single TS constant in `src/server/mcp/presets.ts`; no need for a 199-line module.
- **`src/docket/agent/_helpers.py`, `_item_tools.py`, `_pr_tools.py`, `_commit_tools.py`** as separate files — collapse into `src/agent/tools/readonly.ts`. The leading-underscore naming is a Python idiom that doesn't translate.
- **`src/docket/storage/repos/_tags.py`** — internal tag splitter. Inline into the one query that uses it.
- **`docket --workspace=DIR`** — local-first CLI flag. Hosted has one workspace.
- **`make wheel`, `make clean-workspace`, `make token`, `make serve`** — replaced by `bun run dev` and `bun run build`.

### Consolidate (today they're split, the new tree fuses them)

- `src/docket/api/routes/views.py` + `view_config.py` + `view_overrides.py` → one `src/server/routers/views.ts` router. Three files for one concept is historical drift.
- `src/docket/api/routes/pins.py` + `src/docket/storage/repos/watchlist_repo.py` → unify the name. Pick **`watchlist`** end-to-end (more accurate than "pins"). Delete `pins` from the URL surface.
- `src/docket/storage/repos/{conversation,message}_repo.py` + `src/docket/core/services/conversation_service.py` → one `src/server/conversations/` module: Prisma queries + the orchestration logic that today is in `conversation_service.py` (440 LOC). Remove the repo/service split — Prisma is the repo.
- `src/docket/storage/repos/sync_repo.py` + `src/docket/core/services/sync_service.py` → one `src/server/sync/` module. The 37-line repo wraps two queries; inline them.
- `src/docket/agent/{tool_defs,_item_tools,_pr_tools,_commit_tools,link_tools,memory_tools,source_tools,question_tool,mutating_tools}.py` → `src/agent/tools/{readonly,mutations,memory,source,links,question}.ts`. Fewer files, grouped by intent.
- `src/docket/api/routes/{providers,setup}.py` → `src/server/routers/providers.ts`. With OAuth replacing the wizard, the surface collapses.
- `src/docket/core/services/{proposal_store,question_store,suggestion_service}.py` → live next to their tRPC routers; not separate "core services."

### Rename (cross-cutting, applied phase-by-phase)

The new tree adopts one consistent naming pattern. Every phase's deletion pass enforces these:

- File names: `kebab-case.ts` (not `snake_case.py`, not `camelCase.ts`). Tests: `*.test.ts` co-located.
- Directory names: `kebab-case/` (e.g. `azure-devops`, not `azure_devops`).
- TypeScript identifiers: `camelCase` for values, `PascalCase` for types/components, `SCREAMING_SNAKE` only for true constants.
- Database columns: `camelCase` (Prisma default), with `@@map` only when it would break a join.
- tRPC procedures: `noun.verb` (`items.list`, `proposals.confirm`, `memory.delete`). No `get*` / `set*` prefixes; no plural-vs-singular drift.
- React components: `PascalCase.tsx`, one component per file, named export matching the filename.
- No `_` prefix for "private" — TS module scope handles that. If something is internal, just don't export it.
- No `Service` suffix on classes; prefer modules of pure functions over classes anywhere a class isn't load-bearing.
- No `Repo` / `Repository` suffix; Prisma calls live next to the procedure that owns them.
- Old → new name fixes to apply during the migration:
  - `pins` → `watchlist` (route + UI + DB column)
  - `mutation_service` → `proposals` (the module is the proposal pipeline; "mutation" is what providers do)
  - `external_update_service` → `inbound-changes`
  - `visual_filter` → `view-filter`
  - `mcp_presets` → `mcp-presets` (just a kebab-case rename)
  - `sync_repo` → folded into `sync`
  - `command_usage_repo` → folded into `telemetry/command-usage` (and reconsider whether this is even useful in hosted)
  - `setup_wizard` → `onboarding`
  - `provider_crud` → folded into the providers router
  - `paths.py` / `_pre_workspace_xdg` → gone

## Migration map — old module → new location

| Today (`src/docket/...`) | New tree | Notes |
|---|---|---|
| `core/model.py` | `src/core/types.ts` | Canonical enums, `Item`, `WorkItem`, `Proposal` types |
| `core/mutation.py` | `src/core/proposal-types.ts` | Pure types only |
| `core/services/mutation_service.py` | `src/server/proposals/` (Phase 4) | Builders + executor; renamed (see above) |
| `core/services/proposal_store.py` | `src/server/proposals/store.ts` | Prisma queries |
| `core/services/sync_service.py` + `storage/repos/sync_repo.py` | `src/server/sync/` (Phase 3) | Fused |
| `core/services/conversation_service.py` + `storage/repos/{conversation,message}_repo.py` | `src/server/conversations/` (Phase 5) | Fused |
| `core/services/external_update_service.py` | `src/server/inbound-changes/` (Phase 5) | Renamed |
| `core/services/project_service.py` + `storage/repos/project_repo.py` | `src/server/projects/` (Phase 2) | Fused |
| `core/services/settings_service.py` + `config/models.py` (Settings parts) | `src/server/settings/` (Phase 9) | Fused; Pydantic models → Zod schemas |
| `core/services/suggestion_service.py` + `storage/repos/{search,command_usage}_repo.py` | `src/server/suggestions/` (Phase 9) | Fused |
| `core/services/visual_filter.py` | `src/core/view-filter.ts` (Phase 9) | Pure function; renamed |
| `core/services/mcp_service.py` | `src/server/mcp/` (Phase 8) | Renamed; HTTP-only |
| `agent/factory.py` + `agent/loop.py` + `agent/llm_client.py` | `src/agent/loop.ts` + `src/agent/llm/{types,openai,anthropic,registry}.ts` (Phase 6) | Loop targets ~400 LOC; LLM access goes through adapter interface, two implementations ship (**OpenAI default**, Anthropic peer). |
| `agent/prompt.py` | `src/agent/prompt.ts` (Phase 6) | Markdown imported at build time; no mtime keying needed |
| `agent/{tools,tool_defs,_item_tools,_pr_tools,_commit_tools,link_tools}.py` | `src/agent/tools/readonly.ts` (Phase 6) | Collapsed |
| `agent/{mutating,memory,source,question}_tools.py` | `src/agent/tools/{mutations,memory,source,question}.ts` (Phases 4/6/7) | Renamed; one file each |
| `agent/mcp/manager.py` | `src/agent/mcp-client.ts` (Phase 8) | Smaller — HTTP-only |
| `providers/base.py` (`WorkItemProvider` Protocol) | `src/core/provider.ts` (Phase 1) | TS interface |
| `providers/registry.py` | `src/server/provider-registry.ts` (Phase 1) | Drop entry-point plugin discovery; TS imports are static |
| `providers/azure_devops/` | `src/providers/azure-devops/` (Phase 9) | Against `azure-devops-node-api` |
| `providers/github/` | `src/providers/github/` (Phase 3) | Against `@octokit/rest` |
| `providers/github_stub/` | **DROPPED** (Phase 0) | MSW/vi mocks in tests instead |
| `storage/schema.py` | `prisma/schema.prisma` (Phase 2) | Schema-as-source-of-truth |
| `storage/repos/item_repo.py` | Inlined into items router + sync (Phase 3) | |
| `storage/repos/memory_repo.py` | `src/server/memory/store.ts` (Phase 7) | |
| `storage/repos/source_repo.py` | `src/server/sources/store.ts` (Phase 7) | |
| `storage/repos/comment_repo.py` | Inlined into items router (Phase 3) | |
| `storage/repos/watchlist_repo.py` + `api/routes/pins.py` | `src/server/watchlist/` + `app/api/trpc/[trpc]/route.ts` (Phase 5) | Renamed pins→watchlist |
| `api/app.py` (live + bootstrap) | `app/layout.tsx` + `middleware.ts` + `app/api/trpc/[trpc]/route.ts` (Phase 0/2) | Two-app pattern dropped |
| `api/runtime.py` + `api/agent_rebuild.py` | `src/server/context.ts` (Phase 6) | Per-request `ctx`; no long-lived RuntimeState |
| `api/routes/*.py` (18 files) | `src/server/routers/*.ts` (~9 files) | Consolidated per the audit above |
| `api/spa.py` | Next.js owns the SPA serving (Phase 0) | Gone |
| `api/schemas/` | tRPC procedure input/output Zod schemas, co-located | Drop the separate schemas package |
| `cli/`, `cli/tui/` | **DROPPED** (Phase 0) | |
| `config/paths.py`, `config/secrets.py`, `config/setup_*`, `config/mcp_presets.py`, `config/loader.py`, `config/provider_crud.py` | **DROPPED** (Phase 0) | See audit |
| `config/models.py` (provider/scope/settings dataclasses) | `src/core/config-types.ts` + `src/server/settings/` (Phase 1/9) | Pydantic → Zod |
| `telemetry/logging.py` | `src/server/logger.ts` (Phase 0) | Pino, JSON to stdout |
| `frontend/src/api/` (`schema.d.ts`, `hooks.ts`, `client.ts`, `keys.ts`) | **DROPPED** — replaced by tRPC + react-query | See frontend audit |
| `frontend/src/router.tsx`, `routeTree.gen.ts`, `routes/` | **DROPPED** — Next.js App Router owns routing | |
| `frontend/src/components/setup/` (entire wizard) | `app/admin/setup/` (Phase 11) for the operator wizard; for end-users, NextAuth sign-in + a "pick a project" form | The 9-step CLI/SPA wizard collapses to two screens for users plus a separate operator wizard. |
| `frontend/src/components/{chat,detail,items,memory,sources,mcp,settings,mutations,common,shell}/` | `src/ui/{chat,detail,items,memory,sources,mcp,settings,proposals,primitives,shell}/` | Renamed `mutations` → `proposals`; co-locate, no `_`-prefixed shared files |
| `frontend/src/lib/{cmTheme,theme,formClasses,uiPrefs,env,staleness,...}.ts` | `src/lib/` (trimmed) + `src/server/settings/` for prefs | See frontend audit; most `lib/` modules dissolve |
| `frontend/src/components/**/*Draft.ts`, `newItemHelpers.ts` | **DROPPED** — react-hook-form + Zod replaces ad-hoc draft state | |
| `frontend/biome.json`, `frontend/tsconfig.json` | Single `biome.json`, single `tsconfig.json` at repo root | One config per tool, not two |
| `pyproject.toml`, `uv.lock`, `Makefile` | `package.json`, `bun.lockb` | |

If a file is missing from this table, it's because it's being **dropped**. Confirm before deleting; if it has hidden value, add it to the table during the relevant phase.

## Phased plan

Each phase ends with: `bun run check` (lint + typecheck + test) clean → architecture tests pass → renaming/dedup pass → `git push origin feature/t3-migration`. No phase ships unless its acceptance gate is green.

### Phase 0 — Branch, scaffold, scorched earth

**Goal:** stand up the empty TS tree on the feature branch with auth, db, and a hello-world tRPC procedure.

- Cut `feature/t3-migration` from `main`.
- Delete `src/docket/`, `frontend/`, `pyproject.toml`, `uv.lock`, `Makefile`, `prompts/`, `.docs/prompts/`, `tests/`. Reference them on `main` during the rewrite.
- Scaffold Next.js: `bun create next-app@latest . --typescript --app --tailwind --src-dir --no-eslint --import-alias "@/*"`. Use Biome instead of ESLint (`bun add -D @biomejs/biome` and copy `frontend/biome.json` over).
- Add Prisma: `bun add @prisma/client && bun add -D prisma`. `bunx prisma init` against a Neon dev database.
- Add tRPC v11 + react-query + zod following the official Next.js App Router setup.
- Add NextAuth v5 with the GitHub provider only. Stub Azure DevOps as TODO for Phase 9.
- Add shadcn/ui via `bunx shadcn@latest init` (record any npm fallback the CLI forces).
- Add Pino logger; structured JSON to stdout.
- Add a single tRPC `health.ping` procedure rendered on `/` to prove the wiring.
- Architecture tests: stub Vitest config + a placeholder `src/core/__arch__.test.ts` that fails if `src/core/**` imports from `src/providers/**`.

**Acceptance:** logged-in GitHub user sees "ok" on `/`; `bun run check` clean.

**Push.**

### Phase 1 — Domain core

**Goal:** the provider-agnostic backbone exists in TS with no provider knowledge.

- Port `core/model.py` → `src/core/types.ts`. Canonical enums (`ItemKind`, `ItemState`, `TransitionIntent`), `Item`, `Proposal` discriminated union.
- Port `providers/base.py` → `src/core/provider.ts`. `WorkItemProvider` interface, `ProviderSpec` type (scope axes, axis matchers, label templates).
- Port `core/mutation.py` → `src/core/proposal-types.ts`.
- `src/server/provider-registry.ts` exposes a static array of registered providers (no entry-points; TS imports are static).
- Architecture test: `src/core/**` imports nothing from `src/providers/**`, `src/server/**`, or `src/agent/**`.

**Acceptance:** types compile, registry returns an empty list, arch test green.

**Push.**

### Phase 2 — Database, auth, multi-tenancy

**Goal:** Postgres schema covering every persisted concept; every row scoped by `userId` (and `projectId` where applicable). NextAuth wired to Postgres.

- Prisma schema covering: `User` (NextAuth-managed), `Account`, `Session`, `Project`, `ProjectMembership` (for the future role concept), `OauthProviderConfig` (per-provider OAuth client id/secret/scopes — multi-row, extensible post-deploy), `LlmProvider` (per-LLM API key + kind + label — multi-row, extensible post-deploy; `kind` column accepts future vendors without a schema migration), `Item` (cache), `Comment`, `Watchlist`, `Memory`, `Source`, `Conversation` (includes `llmProviderIdOverride` nullable FK for per-conversation LLM switching), `Message`, `Proposal`, `McpServerConfig`, `Setting`, `Suggestion`, `CommandUsage`, `Sync` (cursor table). Every non-user-scoped table FK to `projectId`. `Project.defaultLlmProviderId` nullable FK to `LlmProvider` (project-level LLM choice; falls back to the global default `LlmProvider`).
- Migrate via `bunx prisma migrate dev`.
- NextAuth's Prisma adapter, with **dynamic provider config**: NextAuth v5's `providers` accepts a function — read `OauthProviderConfig` rows at request time, instantiate one provider per row. Unconfigured providers' sign-in buttons are hidden. Refresh tokens stored in `Account`.
- tRPC `ctx`: `{ session, db, log, projectId? }`. Procedures that need `projectId` declare it as input and the procedure factory enforces a `ProjectMembership` lookup.
- `src/server/projects/` module: list/create/select/import. Multi-project switcher in the shell. Replaces `project_service.py` + `project_repo.py`.
- `src/server/llm/`: `LlmProvider` CRUD; `selectAdapterFor(project)` returns an `LlmAdapter` instance (Phase 6 ships the adapters; Phase 2 ships the registry + selection).
- Helper: `mutationProcedure` (read-only mode aware, role-aware) vs `queryProcedure`.
- Routes are project-scoped: `/projects/[projectId]/items`, `/projects/[projectId]/chat`, etc. The dashboard at `/` lists projects and offers "Add project."

**Acceptance:** sign in with GitHub, create two projects, switch between them via the shell switcher, see the URL `projectId` change, agent context (Phase 6 onwards) rebuilds per project. Arch test still green.

**Push.**

### Phase 3 — GitHub provider, item read paths, sync

**Goal:** end-to-end "list issues from a real GitHub repo" using the user's OAuth token.

- `src/providers/github/`:
  - `provider.ts` (implements `WorkItemProvider` via `@octokit/rest`)
  - `state-map.ts` (provider state ↔ `ItemState` translation; bidirectional check enforced by an arch test mirroring `test_state_map_reverse.py`)
  - `spec.ts` (scope axes, label templates)
- `src/server/sync/` module: full + incremental sync, writes to `Item` cache. Uses the provider's tokens from `Account`.
- `src/server/routers/items.ts`: `items.list`, `items.get`, `items.search`. Reads from the cache.
- Frontend: `app/items/page.tsx`, `app/items/[id]/page.tsx`. Tailwind + shadcn list/detail UI.
- Arch test: no `octokit` import outside `src/providers/github/`.

**Acceptance:** list and view real GitHub issues. Sync runs on demand; no proposals yet.

**Push.**

### Phase 4 — Proposal pipeline

**Goal:** every provider write is proposal-first end-to-end, with the web confirm modal.

- `src/server/proposals/` module: builders (`proposeTransition`, `proposeDescriptionPatch`, `proposeAttachment`, `proposeComment`, `proposeNewItem`), `confirm`, `reject`. Renamed from `mutation_service`.
- tRPC `proposals.create` (mutating) → returns proposal id + diff payload. `proposals.confirm` → executes via the provider, refreshes cache.
- shadcn `<Dialog>` confirm modal in the UI; renders the diff.
- Read-only mode: `mutationProcedure` raises `FORBIDDEN` for `viewer` role.
- Architecture test: no tRPC router imports from `src/providers/*` directly; only via the provider registry indirection.
- Architecture test: no router calls a provider write method (`octokit.issues.update`, etc.) outside `src/server/proposals/executor.ts`.

**Acceptance:** transition a real GitHub issue end-to-end through the confirm modal. Read-only mode blocks it.

**Push.**

### Phase 5 — Conversations + watchlist + inbound changes

**Goal:** the read-side surfaces around items.

- `src/server/conversations/` module: Prisma queries + orchestration (compaction, message storage). Replaces conversation_service + message_repo + conversation_repo (3 files → 1 module).
- `src/server/watchlist/` module: pin / unpin / list. Renamed from `pins`.
- `src/server/inbound-changes/` module: external item change detection → injects synthetic system messages into active conversations. Renamed from `external_update_service`.
- UI: chat panel, watchlist pane.

No agent yet — chat panel renders messages but the assistant is a stub that echoes. Phase 6 wires the agent.

**Acceptance:** can create conversations, pin items, see inbound-change notices.

**Push.**

### Phase 6 — Agent loop

**Goal:** functional parity with `src/docket/agent/` minus the file sprawl.

- `src/agent/llm/types.ts`: `LlmAdapter` interface + vendor-neutral `LlmRequest` / `LlmEvent` / `LlmToolResult` types.
- `src/agent/llm/openai.ts`: **the one shipping adapter** at launch. Uses the latest `openai` Responses API (verify version online before installing). GPT-5 is the default model.
- `src/agent/llm/registry.ts`: `selectAdapterFor(project)` dispatches on `LlmProvider.kind`. Today: one entry (`openai`) + an explicit `default: throw` so a misconfigured row fails loudly instead of silently.
- Architecture test: nothing outside `src/agent/llm/openai.ts` imports `openai`. The same boundary will hold when more adapters arrive.
- `tests/fakes/llm.ts`: scripted fake adapter. The agent loop tests run against this, never the real `openai` SDK — proves the seam is real.
- No Anthropic adapter at launch. Adding one later is a new file under `src/agent/llm/` plus a registry entry; no other agent code changes.
- `src/agent/llm/registry.ts`: `selectAdapterFor(project)` reads `LlmProvider` row, instantiates the matching adapter.
- `src/agent/loop.ts`: streaming agent loop, depends only on `LlmAdapter`. Replaces factory + loop + llm_client.
- `src/agent/prompt.ts`: prompts imported as TS strings at build time (no mtime keying — see audit).
- `src/agent/tools/readonly.ts`: items / PRs / commits / CI tools fused.
- `src/agent/tools/links.ts`: link tools.
- `src/agent/tools/memory.ts`: read-only memory tools (mutations stay in `mutations.ts` from Phase 4).
- `src/agent/tools/source.ts`: read-only source tools (Phase 7 fills the source store).
- `src/agent/tools/question.ts`: agent-asks-user tool.
- Tool registry order pinned by an architecture test mirroring `test_tool_registration_order.py`.
- Streaming chat over a Next.js route handler with `ReadableStream`.

**LLM switcher in the chat pane.** Render the dropdown in the chat pane header. Source: `LlmProvider` rows visible to this project, with the current `defaultLlmProviderId` selected. At launch this is a single non-interactive item (`OpenAI · GPT-5`); the component is fully wired for multi-row state so adding more rows / future adapters lights it up automatically. Picking a non-default row stages a per-conversation override that lasts until the conversation ends (persisted on `Conversation.llmProviderIdOverride`, nullable; the agent loop reads override-or-default at the start of each turn).

**Acceptance:** agent answers (GPT-5 via OpenAI adapter), streams tokens, stages proposals via `mutations.ts` tools, surfaces them to the UI for confirmation. The fake-adapter test suite passes. The architecture test forbidding `openai` imports outside `src/agent/llm/openai.ts` is green — proving that adding a second adapter later is a localized change. The chat pane shows the LLM switcher with the current provider row visible, even though it's a single option today.

**Push.**

### Phase 7 — Memory + sources

**Goal:** project memory and source documents work end-to-end, with the agent treating sources as read-only.

- `src/server/memory/`: list / read / propose-write / propose-delete. Mutations go through the proposal pipeline, same as ticket writes.
- `src/server/sources/`: web file picker (drag-drop or `<input type="file">`) → S3-compatible blob store (or Postgres `bytea` for small files; pick one and document). Source mutations are human-driven only.
- Architecture test: agent tools cannot write sources.

**Acceptance:** upload a source file, agent reads it on demand, project memory survives a refresh.

**Push.**

### Phase 8 — MCP fleet (HTTP-only)

**Goal:** per-project MCP tools work via HTTP-only servers. stdio support is dropped on purpose.

- `src/server/mcp/`: per-project config CRUD, lifecycle.
- `src/agent/mcp-client.ts`: HTTP MCP client wrapping the Model Context Protocol TS SDK.
- Tool registry integration follows the pinned order: MCP tools after source-readonly, before mutating.
- Architecture test: tool order still pinned.

**Acceptance:** add an HTTP MCP server, agent calls one of its tools.

**Push.**

### Phase 9 — Azure DevOps + settings + view filters

**Goal:** second provider; settings UI; view filtering parity.

- Custom NextAuth provider for Azure DevOps OAuth (this is the hard part — AzDO's OAuth is awkward; budget extra time).
- `src/providers/azure-devops/` against `azure-devops-node-api`. Mirrors GitHub provider structure.
- `src/server/settings/`: per-user settings UI + tRPC routes. Pydantic config models → Zod schemas.
- `src/core/view-filter.ts`: pure function port of `visual_filter.py`. Renamed.
- `src/server/routers/views.ts`: fused from views + view_config + view_overrides (3 routes → 1).
- `src/server/suggestions/`: command palette + search history.

**Acceptance:** sign in with AzDO; transition an AzDO work item via the proposal modal; view filters work.

**Push.**

### Phase 10 — Roles, audit, polish

**Goal:** the app is feature-complete and clean. Deployment artifacts come in Phase 11.

- Roles: `viewer` / `member` / `approver` on `ProjectMembership`. Read-only-mode hooks now reuse the role.
- Audit log: `Audit` Prisma model — every confirm writes a row.
- Final dedup/rename pass across the whole tree (see naming conventions). Run a duplication scanner (`bunx jscpd src/ app/`) and resolve anything above 50 LOC.
- Frontend-cleanliness sweep using the frontend audit checklist: no `_`-prefixed files, no `*Draft.ts` modules, no `Pin*` identifiers, no client components above ~200 LOC, every form on react-hook-form + Zod, every modal on shadcn `<Dialog>`.
- Final architecture-test sweep: import boundaries, state-map symmetry, tool registration order, "no provider write outside `src/server/proposals/executor.ts`."
- E2E tests (Playwright) green: sign-in → create project → list items → stage proposal → confirm → audit row appears.

**Acceptance:** every entry in the migration map either reaches the new tree or is explicitly marked dropped. `bun run check` clean. Playwright E2E green.

**Push.**

### Phase 11 — Self-hosted deploy: docker-compose + first-run wizard

**Goal:** one command, `docker compose up`, and a logged-in admin can finish configuration through the UI. No `.env` editing for the things a normal operator should not have to read.

#### `docker-compose.yml` services

- **`db`** — Postgres 16. Persistent named volume. Healthcheck.
- **`app`** — the Next.js production build (output via `next build` in standalone mode). Reads only the *bootstrap* env vars below. Depends on `db` healthy.
- **`worker`** *(optional, only if needed in practice)* — long-running background worker for sync schedulers. Same image as `app`, different command. Decide at Phase 11 whether sync needs to be a separate process or can stay request-driven.

No MinIO. Source files live in `Source.body bytea` for now (decision recorded in Phase 7); revisit if file sizes become a problem.

#### Bootstrap env vars (only what genuinely must be at boot)

These are the only env vars the operator sets in `.env` (or `compose.override.yml`):

| Var | Why it can't be in DB |
|---|---|
| `DATABASE_URL` | App needs it to read anything from the DB, including other config. |
| `AUTH_SECRET` | NextAuth's session-encryption secret. Rotating it logs everyone out, so it has to be process-stable. |
| `SECRETS_KEY` | Symmetric key (32 bytes, base64) the app uses to AES-GCM-encrypt provider secrets at rest in the `Setting` table. Same rotation property as `AUTH_SECRET`. |
| `PUBLIC_BASE_URL` | NextAuth needs the canonical URL for OAuth callback construction *before* it can read DB config. |

If any of these is missing at boot, the container exits with a clear message. A bundled `bin/generate-secrets.sh` produces secure defaults for `AUTH_SECRET` and `SECRETS_KEY` for first-time operators.

#### Everything else lives in DB and is set via the first-run wizard

Acquired through the **first-run admin wizard** at `/admin/setup`, written to the appropriate tables (sensitive fields encrypted with `SECRETS_KEY`):

- **At least one `LlmProvider` row** (required to pass the wizard). At launch the only `kind` available in the picker is `openai` (default model: GPT-5); the row's `kind` column already supports more values, so future adapters appear in the picker without a schema migration. Multiple rows allowed (e.g., separate dev/prod keys, or future vendors when added). The first row created becomes the global default. More can be added later from admin settings — at any time, with no redeploy.
- **At least one `OauthProviderConfig` row** (required to pass the wizard). Wizard supports GitHub and Azure DevOps; one is mandatory, both can be configured. More providers can be added later from admin settings — at any time, with no redeploy. Each row carries its client ID, client secret, scopes, and a callback URL the wizard formats from `PUBLIC_BASE_URL` for copy-paste into the OAuth app.
- Optional: SMTP for transactional email (sign-in invites, password resets if added later).
- App-level toggles: read-only mode default, allow-self-signup, etc.

NextAuth v5's provider config is a function — at request time it reads the current `OauthProviderConfig` rows and instantiates one NextAuth provider per row. Adding a provider in admin settings makes its sign-in button appear on the next page load; no restart, no redeploy. Removing a row likewise hides the button but leaves existing sessions intact.

Same pattern for LLMs: `selectAdapterFor(project)` reads the project's `defaultLlmProviderId` (or the global default) at the start of each agent turn. Rotating an API key, swapping vendors, adding a new model — all live, no redeploy.

#### First-run flow

1. Operator runs `docker compose up`.
2. Container prints a **one-time admin claim token** to stdout (and writes it to a `bootstrap.token` file in a volume so `docker compose logs` isn't the only way to recover it). Token is consumed once and then disabled forever.
3. Operator opens `PUBLIC_BASE_URL/admin/setup?token=<token>`. Token verification creates the admin user (no OAuth available yet).
4. Wizard pages, in order: LLM provider → GitHub OAuth → Azure DevOps OAuth → app-level toggles → confirm.
5. On confirm: the `setup_complete` flag flips to true; the bootstrap token entry is deleted; the admin is now a normal session-authed user; the OAuth providers go live.
6. Subsequent users sign in via OAuth normally. No env-var step ever required.

**Why this shape, not env vars for everything.** Operators should not have to know what `ANTHROPIC_API_KEY` does, or which OAuth callback URL GitHub wants. The wizard owns those concerns: it can show explanations, validate the values (test-call the LLM, exchange a dummy OAuth code), and provide copy-paste-ready callback URLs. Env vars are reserved for the things that genuinely *must* be process-stable (the DB connection, the encryption keys).

#### Local development convenience — `.env.local` seeds the DB

For developer ergonomics, `bun run dev` runs a one-shot **seed step** before starting the server. The seed reads `.env.local` and, *only if the corresponding DB rows are empty*, writes them:

| `.env.local` var | Seeds row |
|---|---|
| `DEV_OPENAI_API_KEY` | An `LlmProvider` row, kind `openai`, label `Local dev (OpenAI)`, set as default if no other LlmProvider exists (GPT-5 is the default model). |
| `DEV_ANTHROPIC_API_KEY` | An `LlmProvider` row, kind `anthropic`, label `Local dev (Anthropic)`. |
| `DEV_GITHUB_CLIENT_ID` + `DEV_GITHUB_CLIENT_SECRET` | An `OauthProviderConfig` row for GitHub. |
| `DEV_AZURE_CLIENT_ID` + `DEV_AZURE_CLIENT_SECRET` + `DEV_AZURE_TENANT` | An `OauthProviderConfig` row for AzDO. |

After the seed, the dev server's runtime code path is **identical to production**: it reads from DB. No `if (NODE_ENV === 'development')` branches in any runtime config reader. The seed is a write-once shortcut, not a runtime fork.

Properties:

- A developer with a populated `.env.local` runs `bun run dev` once, never opens the wizard, and is signed in with `localhost` GitHub OAuth using their dev OAuth app.
- A developer who *changes* a value in `.env.local` and wants the DB to follow runs `bun run dev:reseed` — drops the dev-seeded rows and re-runs the seed. Production has no such command.
- The seed never touches existing DB rows it didn't write; rotating a key in admin settings is permanent, even if `.env.local` still has the old value.
- Seed is gated by `NODE_ENV !== 'production'` and by the absence of `setup_complete = true`. A prod build that accidentally starts with `DEV_*` env vars set is a no-op.

`.env.local` is git-ignored. `.env.local.example` ships with placeholders and a comment pointing at this section.

**Why a single bootstrap token, not "admin email/password" env vars.** Email/password requires SMTP or a password-hashing UX from day one — both more friction than printing a token. The token also self-destructs after one use, which is a stronger property than a reusable env-var-set password.

#### Deliverables

- `docker-compose.yml`, `compose.override.example.yml`, `Dockerfile` (multi-stage; `next build --output standalone`).
- `bin/generate-secrets.sh` (writes a starter `.env` with `AUTH_SECRET` and `SECRETS_KEY` filled).
- `app/admin/setup/page.tsx` + the wizard pages (LLM provider, OAuth provider(s), app toggles, confirm).
- `app/admin/llm-providers/` + `app/admin/oauth-providers/`: post-deploy CRUD UIs for adding more LLM providers and more OAuth providers at any time.
- `src/server/setup/`: token issuance, validation, claim, settings persistence with field-level encryption.
- `src/server/settings/secrets.ts`: AES-GCM encrypt/decrypt helpers using `SECRETS_KEY`.
- `src/server/llm/registry.ts` (from Phase 2/6): now wired into the live admin UI for runtime adapter selection.
- NextAuth dynamic provider-config function reading from `OauthProviderConfig`.
- `src/server/middleware.ts`: redirect every authenticated route to `/admin/setup` while `setup_complete` is false (and the request session is the admin claim token).
- `bin/seed-dev.ts`: the dev-seed script described above. Wired to `bun run dev` via a `predev` script.
- `.env.local.example` documenting the `DEV_*` vars.
- A `README.md` "Self-hosting" section covering: prerequisites, `cp compose.override.example.yml compose.override.yml`, `docker compose up`, retrieving the token, finishing the wizard.
- Smoke test (Playwright in CI): boot a clean stack, claim the token, walk the wizard with stub OAuth, sign in via stub, run the proposal-first flow.

#### Acceptance

- `docker compose up` from a clean checkout brings the stack up.
- Container logs print the bootstrap token exactly once.
- Visiting `/admin/setup?token=...` walks the wizard end-to-end without touching the host filesystem or `.env`.
- Wizard refuses to complete until at least one `LlmProvider` and at least one `OauthProviderConfig` exist.
- After completion, restarting the stack does *not* re-issue a token, does *not* show the wizard, and signs admin in via OAuth like any other user.
- Adding a second `LlmProvider` (e.g., Anthropic alongside the default OpenAI) post-setup, then changing a project's `defaultLlmProviderId`, swaps the agent adapter on the next chat turn — no restart.
- Adding a second `OauthProviderConfig` (e.g., AzDO alongside GitHub) post-setup makes the AzDO sign-in button appear on the next page load — no restart.
- `bun run dev` on a clean checkout with a populated `.env.local` brings up a working stack without ever opening the wizard.
- Rotating `SECRETS_KEY` requires a documented re-encrypt step (script provided); rotating `AUTH_SECRET` is documented as "expect everyone to sign in again."
- `bun run check` and Playwright E2E green.

**Push.**

### Phase 12 — Merge and sunset

- Tag the last `main` commit before merge as `v0.x-final-python` for archive purposes.
- Merge `feature/t3-migration` → `main` (fast-forward; this is solo). Delete the feature branch.
- Delete `.docs/T3_MIGRATION_SKETCH.md` (this file) — obsolete after merge. Replace with a one-paragraph "this used to be Python; here's the archive tag and how to self-host" note in `README.md`.

**Acceptance:** `main` builds, deploys, and runs the proposal-first flow end-to-end against real GitHub and Azure DevOps tenants.

## Risks worth flagging early

- **OAuth scope sprawl.** GitHub Apps and Azure DevOps OAuth grants are coarse; getting "read everything you can see + write only what you confirm" right is non-trivial, especially for AzDO.
- **MCP sandboxing.** Running user-configured MCP servers as server-side subprocesses is a security problem. The plan above answers this by allowing only HTTP-based MCP servers in Phase 8. That's a real feature regression for power users — surface it in release notes.
- **Token refresh storms.** OAuth refresh on a hot path during sync can hammer the provider. Per-user token cache + backoff in the provider adapter.
- **Cost.** A hosted agent calling Claude on behalf of N users is a real per-user cost. Decide the billing story (free tier? paid tier? BYO API key?) before Phase 6, not after.
- **Loss of "I trust this because it runs on my laptop."** Some users care a lot about that property. Hosted means we hold their tokens, their tickets, their proposals. Different trust model entirely; flag in onboarding copy.
- **AzDO OAuth specifically.** Azure DevOps OAuth is being deprecated in favor of Entra ID flows. Confirm which is current at Phase 9; the implementation may diverge from "stock NextAuth custom provider."
- **Phase length.** Phases 3, 4, 6, and 9 are each ~1–2 weeks of focused work. Don't promise anyone a date.

## Trigger conditions — the "should we start?" gate

Don't open Phase 0 until at least one of these is true:

- Decision to offer Docket as a hosted service (paid or free) for >1 user.
- Demand for team-shared projects/memory/proposals (multiple humans on the same provider scope).
- "I want to use Docket from my phone / a borrowed laptop" becomes a recurring ask.
- Operational cost of supporting `gh` / `az` CLI auth across user environments exceeds the cost of running OAuth ourselves.

If none are true, keep simplifying the Python tree per `project_simplification_roadmap`.
