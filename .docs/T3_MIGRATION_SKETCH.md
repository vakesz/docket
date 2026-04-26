# T3-stack migration — draft sketch

**Status:** speculative. Not greenlit, not scheduled. Captured so future-us doesn't have to re-derive the calculus.

## Why this might happen

Docket today is a **local-first single-user tool**: CLI + TUI + FastAPI + SPA, all one Python process, one SQLite file, secrets in OS keychain, provider auth via the user's `gh` / `az` CLI sessions. That shape is great for a personal ticket-wrangling tool and bad for a multi-user hosted product.

The migration only makes sense if the product pivots to **hosted multi-user SaaS**. Without that pivot, T3 is a sideways move — see `Why this is not a clear win today` below.

## Trigger conditions (don't migrate until at least one is true)

- Decision to offer Docket as a hosted service (paid or free) for >1 user.
- Demand for team-shared projects/memory/proposals (multiple humans on the same provider scope).
- "I want to use Docket from my phone / a borrowed laptop" becomes a recurring ask.
- Operational cost of supporting `gh` / `az` CLI auth across user environments exceeds the cost of running OAuth ourselves.

If none of these are true, stay on Python.

## Target shape

- **Next.js (App Router)** — single deploy, SPA + API routes in one tree.
- **tRPC** — replaces the FastAPI + OpenAPI + `bun run gen:api` codegen loop. Frontend imports server router types directly; no manual DTO sync.
- **Prisma** + **Postgres** (Neon / Supabase / Railway) — replaces `src/docket/storage/schema.py` + the repo classes. Migrations via `prisma migrate`. Multi-tenant rows scoped by `userId` / `orgId`.
- **NextAuth** — OAuth providers for GitHub (built-in) and Azure DevOps (custom). Replaces the `gh auth` / `az login` session probing in `src/docket/config/setup_discovery.py` and the bootstrap-token flow in `src/docket/api/app.py`.
- **Anthropic TS SDK** — agent loop, prompt caching, tool use. Functional parity with `src/docket/agent/` is achievable; it's a port, not a redesign.
- **Tailwind + shadcn/ui** — replaces the current React + Vite SPA styling. Keeps a familiar component vocabulary.
- **Vercel / Fly / Render** for hosting. No more `make wheel`.

Dropped surfaces:
- **Typer CLI** — gone. Anything CLI-shaped becomes a web flow or an API call.
- **Textual TUI** — gone. The SPA is the only client.
- **Single-wheel install** — gone. You deploy a server; users hit a URL.
- **XDG-managed local workspace** — gone. State lives in Postgres scoped by user.

## What carries over conceptually

The architectural invariants worth preserving across the rewrite:

1. **Proposal-first mutation.** Builders → diff render → explicit confirm → execute. The shape works the same in tRPC: a `proposals.create` mutation stages, a `proposals.confirm` mutation executes. Diff rendering becomes a web modal.
2. **Provider abstraction at the boundary.** `WorkItemProvider` Protocol becomes a TS interface. `ProviderSpec` (scope axes, axis matchers, label templates) ports cleanly. State maps stay per-provider.
3. **Canonical types in the core.** `ItemKind`, `ItemState`, `TransitionIntent` become a shared TS module imported by both server and tRPC consumers.
4. **Read-only mode** still strips mutating tRPC procedures and mutating agent tools. Same invariant, different enforcement layer.
5. **Prompt-prefix byte stability** still matters. The prompt cache works the same way in the TS SDK; tool registration order is still load-bearing.
6. **MCP per-project config.** Becomes a per-user / per-project record in Postgres. The server spawns/manages MCP processes — different operational shape than spawning on the user's laptop, see Risks.
7. **Source documents excluded from prompt prefix.** Same rule, same reason.
8. **Compaction + external-update injection.** Port directly.

## What changes (not just translates)

- **Auth.** Per-user OAuth tokens stored server-side (encrypted at rest). No more keychain. Token refresh becomes our problem, not the user's.
- **Provider writes.** Done with the user's OAuth token, not their CLI session. Scope/permission model is whatever the OAuth app grants.
- **MCP fleet.** Hosted, sandboxed, multi-tenant. Per-user subprocesses on a server is a real operational problem (resource limits, isolation, lifecycle, secrets injection). May force a switch to MCP-over-HTTP servers only, no stdio.
- **SQLite → Postgres.** Cache rows are now multi-tenant. Every query gets a `userId` filter. Proposal store, message store, watchlist all gain tenancy.
- **Setup wizard.** Becomes a normal first-login flow over OAuth, not a bootstrap-token gated SPA. The whole `create_bootstrap_app` / `window.__DOCKET_TOKEN__` dance disappears.
- **Project switching.** Becomes a route param / session selector instead of a runtime rebind. Agent factory still rebuilds tool closures per (user, provider, project) tuple.
- **Telemetry.** JSON-lines to stdout for the platform's log collector. Drop the rotating-file logger.

## Why this is not a clear win today

- **Surface mismatch.** TUI + CLI are >50% of how the tool is used today. T3 covers neither.
- **Provider SDKs.** Python `azure-devops` and PyGithub are mature; rewriting against `azure-devops-node-api` and `@octokit/rest` is weeks of port work for parity, no new value.
- **Agent ecosystem.** Anthropic's Python SDK is fine in TS, but if Docket grows eval harnesses, fine-tuning experiments, or anything data-sciencey, Python is the right language for it.
- **Operational complexity.** Local-first means zero ops. Hosted multi-user means real ops — backups, secret rotation, OAuth app management, MCP sandboxing, per-tenant rate limits.
- **Existing code is good.** The current architecture is clean, the invariants are tested, the simplification roadmap is mid-flight (see `project_simplification_roadmap`). Throwing it out for "same product, different runtime" is wasteful.

## Migration phasing (rough — only relevant if a trigger fires)

1. **Carve out a hosted backend.** Stand up Next.js + tRPC + Postgres + NextAuth with GitHub OAuth only. Port `WorkItemProvider` interface and the GitHub provider. No agent, no proposals — just list/show items as a smoke test for the multi-tenant data model.
2. **Port the proposal pipeline.** Builders, diff rendering, confirm/reject, mutation execution. Web modal as the confirm surface. Read-only mode flag at the procedure layer.
3. **Port the agent.** Anthropic TS SDK, prompt loader (mtime-keyed still works), tool registry in pinned order, compaction service, external-update injection.
4. **Add Azure DevOps provider + OAuth.** Custom NextAuth provider; port the AzDO adapter.
5. **Port MCP.** Decide on stdio-vs-HTTP-only policy first. Hosted MCP fleet with per-user/per-project lifecycle.
6. **Port memory + sources.** Repos become Prisma models. Source upload becomes web file-picker, not a CLI command.
7. **Sunset the Python tree.** Tag a final wheel for users who want the local-first build, then archive.

Each phase is a real chunk of work — weeks, not days. Don't start until the trigger conditions justify it.

## Risks worth flagging early

- **OAuth scope sprawl.** GitHub Apps and Azure DevOps OAuth grants are coarse; getting "read everything you can see + write only what you confirm" right is non-trivial, especially for AzDO.
- **MCP sandboxing.** Running user-configured MCP servers as server-side subprocesses is a security problem. Likely answer: only allow HTTP-based MCP servers, drop stdio support. That's a real feature regression for power users.
- **Token refresh storms.** OAuth refresh on a hot path during sync can hammer the provider. Need careful caching + backoff.
- **Cost.** A hosted agent calling Claude on behalf of N users is a real per-user cost. The local-first version costs the user nothing operationally; the hosted version needs a billing story.
- **Loss of the "I trust this because it runs on my laptop" property.** Some users care a lot about that. Hosted means we hold their tokens, their tickets, their proposals. Different trust model entirely.

## Pros / cons at a glance

### Pros of moving

- **One language, one repo, one deploy.** TS everywhere. No FastAPI/Vite split, no `bun run gen:api` dance, no two lint+typecheck stacks.
- **End-to-end types via tRPC.** Server router types flow into the React tree directly. The current OpenAPI codegen step (and its drift risk) goes away.
- **Prisma migrations.** Schema-as-source-of-truth, generated client, automatic migration diffs. Replaces hand-rolled SQL in `src/docket/storage/schema.py`.
- **NextAuth handles OAuth.** GitHub provider is built-in; Azure DevOps is a custom provider but the framework gives you the callback/refresh/session primitives for free.
- **Multi-user falls out of the stack.** Session → `userId` → row-level scoping in Prisma. No retrofitting tenancy onto a single-user data model.
- **Hosted deploy is a known shape.** Vercel / Fly / Render. No "build a wheel and ship it" story to maintain.
- **Frontend ecosystem.** shadcn/ui, Tailwind, Next.js routing, server components, streaming SSR. The React + Vite SPA today is fine but it's a thinner toolkit.
- **Mobile/borrowed-laptop access.** It's a URL. Done.

### Cons of moving

- **Total rewrite.** Everything in `src/docket/` is gone. Provider adapters, agent loop, proposal pipeline, MCP manager, memory/source repos, setup discovery, prompt loader, compaction — all ported, not migrated. Weeks of work for parity, no new product value during that time.
- **Provider SDK regression.** `azure-devops` (Python) and PyGithub are mature and well-typed in our usage. `azure-devops-node-api` is less polished; `@octokit/rest` is fine but you lose the existing test fixtures and the `pytest-recording` cassettes.
- **Operational burden.** Hosted means backups, secret rotation, OAuth app management, monitoring, on-call, abuse handling. Today: zero ops.
- **Per-user inference cost.** We now pay for Claude calls on behalf of N users. Needs a billing story (free tier? paid tier? BYO API key?). Today: user pays Anthropic directly.
- **Trust model shift.** We hold their OAuth tokens, their cached tickets, their proposals, their chat transcripts. Some current users specifically value the "runs on my laptop, secrets in my keychain" property. Losing that is a product change, not a technical one.
- **MCP sandboxing problem (see Risks).** Likely forces dropping stdio MCP servers — a real feature regression.
- **Python ecosystem loss.** Future eval harnesses, dataset tooling, fine-tuning experiments are awkward in TS.
- **Sunk cost on simplification.** The Python tree is mid-flight on a 7-phase simplification roadmap. Migrating now wastes that work.

## What has to be dropped, and why

| Dropped | Why it can't carry over |
|---|---|
| **Typer CLI** (`src/docket/cli/`) | T3 has no CLI surface. Node CLI tools exist (oclif, commander) but they'd be a separate codebase, defeating the "one stack" pro. The CLI commands become web flows or tRPC procedures. |
| **Textual TUI** (`src/docket/cli/tui/`) | Same reason. No browser-equivalent of a terminal UI in T3. Already accepted upthread. |
| **Single-wheel install** (`make wheel`) | Hosted SaaS has no install. The wheel exists because we ship a runnable artifact; we'd ship a URL instead. |
| **XDG-managed local workspace** (`src/docket/config/paths.py`) | Per-user state lives in Postgres scoped by `userId`. No on-disk config dir, no `--workspace=DIR` flag, no `.docket-dev`. |
| **OS keychain for secrets** (`src/docket/config/secrets.py`) | We hold tokens server-side now (encrypted at rest in Postgres or a KMS). The keyring abstraction exists today specifically because secrets stay on the user's machine; that property is gone. |
| **`gh` / `az` CLI session probing** (`src/docket/config/setup_discovery.py`) | Replaced wholesale by OAuth. We don't shell out to the user's CLI tools; we hold our own delegated tokens. |
| **Bootstrap-token flow** (`create_bootstrap_app`, `window.__DOCKET_TOKEN__`) | The whole "first-run mints a token, SPA injects it into `index.html`" dance exists because there's no user system. With NextAuth, first login is a normal OAuth flow. |
| **SQLite cache** (`src/docket/storage/`) | Multi-tenant on SQLite is awkward. Postgres + Prisma is the obvious target. The cache concept stays; the engine changes. |
| **Rotating file logger** (`src/docket/telemetry/logging.py`) | Hosted apps log to stdout for the platform's collector. The rotating-file design is a local-first concession. |
| **stdio-based MCP servers** (likely) | Spawning user-configured subprocesses on a shared server is a security problem. Realistic scope: HTTP-only MCP servers. Power users who run local stdio servers lose that. |
| **"It runs on my laptop"** | Not a file, but a property. Some users will leave over this; that's the cost of the pivot. |

## Benefits of moving to OAuth + multi-user

This is the core of the pivot. Worth being explicit about what changes for the better.

### OAuth specifically

- **No more "did the user run `gh auth login`?"** Today's setup wizard probes `gh` and `az` sessions and fails confusingly when they're missing or expired. OAuth flips it: we own the dance, the user clicks "Connect GitHub" and it works.
- **Token refresh is our problem, not the user's.** Long-lived sessions without "your `az` token expired, run this command" friction.
- **Scope is explicit and revocable.** GitHub App permissions / AzDO OAuth scopes are negotiated up front. Users can revoke from the provider's settings page. Today the boundary is "whatever your CLI session can do," which is implicit and broad.
- **Audit trail at the provider.** Provider-side audit logs show "Docket app did X on behalf of user Y" — better story for orgs that care.
- **No secret-handling on the user's box.** No keychain access prompts, no "we touched your keychain," no per-OS keyring backend quirks.
- **Onboarding compresses to one click.** Today: install Docket, run setup wizard, ensure CLI sessions, configure provider scope. Tomorrow: visit URL, sign in with GitHub, pick a project.

### Multi-user specifically

- **Team-shared projects.** Multiple humans can chat with the agent over the same provider scope, see each other's proposals, hand off tickets. Today: each user has their own SQLite, no sharing.
- **Shared memory / sources.** Project memory and source documents become a team artifact, not a per-laptop one. Onboarding a new teammate to a project's context becomes "add them to the project," not "copy these files."
- **Read-only roles.** Proposal-first safety extends to authorization: viewers can chat and stage proposals, only approvers can confirm. Today there's no role concept.
- **Centralized observability.** One log stream, one metrics store. Today telemetry lives in each user's `~/.local/share/docket/logs/`.
- **One MCP fleet per project, not per laptop.** The team shares a configured MCP setup. No "wait, you need to install this MCP server locally first."
- **Offers a real product surface.** Hosted SaaS can be sold/distributed/promoted. Local-first CLI tool is harder to grow beyond Hacker News + word of mouth.
- **Cross-device continuity.** Start a chat on your laptop, finish on your phone. Conversations and proposals persist server-side.
- **Easier support.** "Send me your workspace logs" becomes "I can already see your session." Lower barrier to debugging user issues.

### Caveats that come bundled with these benefits

- All of these are also *responsibilities*. Holding tokens means we're now a credential custodian. Holding chats means we're now a data custodian. Multi-user means roles, audit, and abuse handling.
- The OAuth benefits assume we register and maintain a GitHub App + AzDO OAuth app. That's a real ongoing operational commitment.
- "Easier support" only kicks in if we instrument well from day one; otherwise it's just more data we don't know how to use.

## Decision marker

Revisit this doc when one of the trigger conditions fires. Until then: keep simplifying the Python tree per `project_simplification_roadmap`.
