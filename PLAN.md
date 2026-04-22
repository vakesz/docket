# PLAN.md — Docket Bun + TanStack Start Frontend

This plan adds a web frontend to the Docket project at `/Users/vakesz/projects/docket`. The frontend is a Bun-runtime TanStack Start app that mirrors every capability of the Textual TUI. It is executable top-to-bottom without further discovery — every file path is absolute from the repo root, every signature is explicit, and every phase ends in a verifiable artifact.

Ship directly on `main`. Phases are execution order, not branches.

## Settled stack (do not re-debate)

- **Runtime / tooling:** Bun 1.3, TypeScript 5.x, Vite (via Start), `openapi-typescript`
- **Framework:** TanStack Start v1.0 (SSR, server routes, bundles TanStack Router)
- **Data / state:** TanStack Query 5.99, TanStack Form
- **Styling:** Tailwind CSS, `@fontsource-variable/inter`, `@fontsource/jetbrains-mono`
- **UI primitives:** `react-resizable-panels`, `cmdk`, `lucide-react`, `react-markdown`, `@uiw/react-codemirror` + `@codemirror/lang-markdown`, `@tanstack/react-virtual`
- **Design:** Linear-inspired. Zinc neutrals, single indigo accent (`indigo-500`), Inter UI + JetBrains Mono for IDs/diffs, hairline `border-zinc-200/60 dark:border-zinc-800/60`. `prefers-color-scheme` + manual toggle persisted to `localStorage`.
- **Layout:** three `react-resizable-panels` (items list / detail / chat) + top bar (logo, active scope, active provider, connection dot, Cmd+K) + status footer. Sizes persisted in `localStorage` (`docket.layout.panel-sizes.v1`).
- **Auth:** single-user bearer token. Token lives as `DOCKET_API_TOKEN` env var on the Start container. All browser → backend traffic goes through Start server routes under `/api/*`. The browser never sees the token. SSE is proxied using `fetch` + `ReadableStream` (not `EventSource`, because `EventSource` can't send `Authorization` and can't POST).
- **Refresh:** manual only. No SSE external-update watcher.

---

## Phase 1 — Backend: new HTTP endpoints for TUI-only features

Six new route modules (or additions to existing modules where they make more sense) exposing TUI-only functionality over HTTP. All follow existing conventions:

- DTOs in `src/docket/api/schemas.py` (extend the existing file; all schema classes live there)
- Routers in `src/docket/api/routes/<name>.py`, registered in `src/docket/api/app.py::create_app`
- `Depends(require_bearer)` at router level
- Mutating routes add `Depends(require_not_read_only)` at router or endpoint level
- Tests in `tests/test_api_<name>.py` using the `FakeProvider` + `TestClient` pattern from `tests/test_api.py`

### Endpoint summary

| Method + Path | Purpose | Mutating | Module |
| --- | --- | --- | --- |
| `GET /items/{id}/pinned` | Is this item pinned? | no | `pins.py` |
| `POST /items/{id}/pin` | Pin it | yes | `pins.py` |
| `DELETE /items/{id}/pin` | Unpin | yes | `pins.py` |
| `GET /pinned` | List pinned items | no | `pins.py` |
| `POST /items/{id}/suggestion` | One-shot suggestion | no (read-only LLM call) | `suggestions.py` |
| `POST /items/{id}/suggestion/stage` | Stage suggestion → proposals | yes | `suggestions.py` |
| `GET /prompts` | List templates + customized flag | no | `prompts.py` |
| `GET /prompts/{key}` | Read one template | no | `prompts.py` |
| `PUT /prompts/{key}` | Save edit | yes | `prompts.py` |
| `DELETE /prompts/{key}` | Restore canonical | yes | `prompts.py` |
| `GET /settings` | Redacted config | no | `settings.py` |
| `PATCH /settings` | Partial update, atomic save | yes | `settings.py` |
| `GET /scopes` | Scopes on active provider | no | `scopes.py` |
| `GET /scopes/active` | Currently active | no | `scopes.py` |
| `PUT /scopes/active` | Switch | yes (session-scoped) | `scopes.py` |
| `GET /providers` | All configured | no | `providers.py` |
| `GET /providers/active` | Currently active | no | `providers.py` |
| `PUT /providers/active` | Switch | yes (session-scoped) | `providers.py` |
| `POST /sync` | Manual refresh, returns summary | yes | `sync.py` |
| `GET /status` | connection dot + last sync + offline + read_only | no | `status.py` |

The settings/scopes/providers/sync additions all need `Paths` and `Config` injected. Extend `create_app` to accept them; they're already resolved by `docket serve` (see `cli/commands/serve.py` via `prepare_or_wizard`).

### Files to modify

- `src/docket/api/app.py` — add `paths: Paths | None`, `config_ref: ConfigRef | None`, `sync_scope: Callable[[], tuple[str, ScopeFilters]]`, and `providers: dict[str, WorkItemProvider] | None` to `create_app`. Store on `app.state`. Include the seven new routers. `ConfigRef` is a tiny mutable wrapper (defined in `api/runtime.py`, see below) because scope/provider switches mutate session state.
- `src/docket/api/deps.py` — add `get_paths`, `get_config_ref`, `get_providers_map`, `get_runtime` (returns the mutable `RuntimeState`) with the same error pattern as `get_conn`.
- `src/docket/api/schemas.py` — add DTOs listed below.
- `src/docket/cli/commands/serve.py` — pass `paths`, `config`, `providers` dict, and a `RuntimeState` instance to `create_app`.

### Files to create

See original plan for all router signatures, DTOs, and RuntimeState shape.

### Order of operations for Phase 1

1. Add DTOs to `schemas.py` (pure types — compile first, then fill handlers).
2. Add `runtime.py` and extend `deps.py` / `app.py` signatures.
3. Update `serve.py` to construct `RuntimeState` and pass it in.
4. Implement each router in the order above (pins → suggestions → prompts → settings → scopes → providers → sync → status).
5. Write tests alongside each router.
6. Run `uv run pytest tests/test_api*.py && uv run ruff check . && uv run mypy src`.

---

## Phase 2 — Frontend scaffold

### Directory layout

```tree
frontend/
  package.json
  bun.lock
  tsconfig.json
  app.config.ts                 # TanStack Start config
  vite.config.ts                # only if Start needs overrides
  tailwind.config.ts
  postcss.config.js
  .gitignore
  .dockerignore
  Dockerfile
  README.md

  src/
    app.tsx                     # Start root export
    styles/globals.css

    api/
      schema.d.ts               # generated by openapi-typescript
      client.ts                 # typed fetch wrapper
      keys.ts                   # React Query key factory
      hooks.ts                  # useQuery/useMutation hooks grouped by resource

    server/                     # Start server routes (run on Bun, not browser)
      proxy.ts                  # generic backend proxy
      sse.ts                    # SSE streaming proxy

    routes/
      __root.tsx
      index.tsx                 # redirect to /items
      items.tsx                 # three-pane shell (outlet for detail)
      items.$itemId.tsx
      items.$itemId.mutations.$proposalId.tsx
      items.new.tsx
      prompts.tsx
      prompts.$key.tsx
      settings.tsx

    components/
      shell/{TopBar,StatusFooter,ConnectionDot,ThreePaneLayout,ResizableDivider}.tsx
      items/{ItemsList,ItemRow,ItemsFilter,PinnedSection}.tsx
      detail/{ItemDetail,AcceptanceCriteria,CommentsList,LinkedItems,AttachmentsList}.tsx
      chat/{ChatPane,ChatMessage,ChatInput,StreamingMarkdown,ProposalCard}.tsx
      mutations/{DiffCard,BatchReviewList,NewItemSheet,SuggestionSheet}.tsx
      prompts/{PromptLibrary,PromptEditor}.tsx
      settings/{SettingsForm,ScopeSwitcher,ProviderSwitcher}.tsx
      palette/CommandPalette.tsx
      common/{Button,Input,TextArea,Select,Toast,EmptyState,SkeletonRow,Kbd}.tsx

    lib/
      theme.ts                  # dark/light toggle, system pref
      keybindings.ts            # global key handler + palette/chord registry
      markdown.tsx              # react-markdown config + code highlighting
      redaction.ts              # mirror of backend redaction masks for preview
      time.ts                   # relative-time formatter
      diff.ts                   # renders DiffCard from ProposalDTO
      layout.ts                 # localStorage persistence for panel sizes
      errors.ts                 # typed error envelopes + toasts
      env.ts                    # reads DOCKET_API_URL / etc. server-side
      sse.ts                    # small SSE parser for fetch+ReadableStream

    test/smoke.test.ts
```

### Dependencies (pin minors)

```text
"@tanstack/react-start": "^1.0",
"@tanstack/react-router": "^1.0",
"@tanstack/react-query": "^5.99",
"@tanstack/react-virtual": "^3.13",
"@tanstack/react-form": "^0.47",
"react": "^19", "react-dom": "^19",
"react-resizable-panels": "^2.1",
"cmdk": "^1.0",
"lucide-react": "^0.400",
"react-markdown": "^9.0", "remark-gfm": "^4.0",
"@uiw/react-codemirror": "^4.23", "@codemirror/lang-markdown": "^6.3",
"@fontsource-variable/inter": "^5.0", "@fontsource/jetbrains-mono": "^5.0"
```

Dev deps: `typescript`, `@types/react`, `@types/react-dom`, `tailwindcss`, `postcss`, `autoprefixer`, `openapi-typescript`, `@types/bun`.

Scripts: `dev`, `build`, `start`, `gen:api` (openapi-typescript against backend `/openapi.json`), `typecheck`, `test`.

### Server proxy (runs on Bun, not browser)

`src/server/proxy.ts` forwards `/api/*` to `DOCKET_API_URL` with `Authorization: Bearer ${DOCKET_API_TOKEN}`. `src/server/sse.ts` pipes through with `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, dropping `content-length`.

### Order

1. `cd frontend && bun init`, replace `package.json`, `bun install`.
2. Configs (`tsconfig`, `app.config.ts`, `tailwind.config.ts`, `postcss.config.js`).
3. Placeholder `app.tsx`, `__root.tsx`, `index.tsx`, `items.tsx`.
4. `bun dev` sanity check.
5. With backend running: `bun run gen:api`.
6. Proxy + SSE server routes.
7. `client.ts`, `keys.ts`, `hooks.ts`.
8. Shell components + `/items` rendering.

---

## Phase 3 — Frontend features

Feature clusters (one logical unit each). Routes are TanStack Router file-based paths.

### 3.1 Items list & detail

`/items`, `/items/$itemId`. Virtualized list (`react-virtual`), filter debounced 150ms, pinned section at top. Keys: `j`/`k`, `Enter`, `w` (pin), `/` (filter focus), `r` (sync), `o` (open in browser), `s` (suggest), `t` (new thread), `d` (review proposals). Acceptance-criteria sidebar parses `- [ ]`/`- [x]` lines; editing stages a description_patch proposal.

### 3.2 New item

`/items/new` (sheet overlay). TanStack Form. Two-step: `POST /items?dry_run=true` for preview → `POST /items` on confirm.

### 3.3 Mutation review

Inline `ProposalCard` in chat + standalone `/items/$itemId/mutations/$proposalId` route. Batch review when ≥2 pending. Uses existing `/items/{id}/mutations/{pid}/{confirm,reject}` endpoints.

### 3.4 Chat streaming

Right pane on `/items/$itemId`. `fetch`+`ReadableStream` parser. Events: `delta` → append, `message` → persist, `proposal` → render card, `done` → update usage, `error` → toast. Abort on route change.

### 3.5 Pins

Pin icon on `ItemRow` + `ItemDetail`. `PinnedSection` at list top. Optimistic toggle, rollback on error. Key `w`.

### 3.6 Suggest next

`SuggestionSheet` opened by `s`. `POST /items/{id}/suggestion` → edit in sheet → `POST /items/{id}/suggestion/stage` → route to review.

### 3.7 Prompt library

`/prompts`, `/prompts/$key`. CodeMirror + markdown. Save (Cmd+S), Restore default.

### 3.8 Settings

`/settings`. Section-grouped form (Foundry, HTTP, LLM, UI, Sync, Stale). Each section `PATCH`es its slice. `requires_restart` banner.

### 3.9 Scope + provider switchers

Top-bar dropdowns + `/settings` + palette. Switch invalidates `qk.items.all`, `qk.pinned`, `qk.status`.

### 3.10 Command palette (Cmd+K)

`cmdk`. Commands: navigate, item actions (pin, open, suggest, new thread, transitions), global (sync, toggle theme, new item, review pending, help), scope/provider switches. Chords: `g i`, `g p`, `g s`.

---

## Phase 4 — Docker

Files:

- `Dockerfile.backend` (python:3.12-slim + uv, `CMD docket serve --host 0.0.0.0 --port 8000`)
- `frontend/Dockerfile` (oven/bun:1.3 multi-stage → slim runtime)
- `compose.yaml` (prod, two services, backend has no ports, frontend on `DOCKET_FRONTEND_PORT`, volumes `docket-config`/`docket-state`)
- `compose.dev.yaml` (overlay with bind mounts + `bun dev`)
- `.dockerignore` at repo root and `frontend/`
- `.env.example` appended with `DOCKET_API_TOKEN` and `DOCKET_FRONTEND_PORT`

Healthcheck: backend `curl /healthz`, frontend `bun -e "fetch(...)"`.

---

## Phase 5 — Verification

1. Seeded backend (github_stub) + `bun dev` against it.
2. Walkthrough checklist covering every feature cluster.
3. `uv run pytest && uv run ruff check . && uv run mypy src && bun run typecheck && bun test`.
4. `docker compose up --build` reruns the checklist.

## Cross-cutting conventions

- **Import boundary** stays enforced — new routes speak to `WorkItemProvider` only.
- **Named intents**, not state strings.
- **Confirm-before-mutate** for every mutating flow.
- **Cache-stable prompts** — no dynamic data in prefix (existing mtime cache handles hot-reload).
- **Secrets never in the browser** — token lives in Start container env.
- **Markdown canonical** — `react-markdown` + `remark-gfm`; no provider HTML.
