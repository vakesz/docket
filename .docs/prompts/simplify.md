# Simplify — aggressive DRY + canonical-pattern enforcement pass

A re-runnable simplification prompt for the **whole repo** (Python backend +
React/TanStack frontend). Each pass converges the codebase toward **one
canonical way** per concern, deletes duplication, and removes accidental
complexity — without changing intended behavior or touching the load-bearing
invariants in [CLAUDE.md](../../CLAUDE.md).

## How to use this prompt

- **Default scope:** the whole repo — `src/docket/**` and `frontend/src/**`.
- **Optional scope** (pass as argument): a tree (`backend`, `frontend`), a
  module (`src/docket/api/`, `frontend/src/components/items/`), or a
  changeset (`HEAD~5..HEAD`, `git diff main`). Restrict findings and the
  execution gates to that scope; everything else is "Do not touch".
- **Re-runnable.** Run this prompt in successive passes. Each pass leaves the
  tree greener. A pass that finds nothing high-value-low-risk is a successful
  termination — say so and stop.
- **Solo, main-only, no backward-compat.** Delete legacy outright; never add
  shims, deprecation paths, or `_v2` suffixes (per memory + CLAUDE.md).

## Goal

Identify the highest-value opportunities to:

1. **Collapse duplication** — three near-identical sites collapse into one
   primitive at the canonical home.
2. **Align with the canonical pattern** — when a site diverges from the
   prescribed shape below without a documented reason, conform it.
3. **Remove accidental complexity** — wrappers around one call, unused
   indirection, classes that should be functions, `useEffect` doing the work
   of `useMemo`, broad `except` swallowing real errors.
4. **Improve long-term maintainability** — code that reads linearly,
   localizes each reason-to-change, and lets the next reader predict
   structure across modules.

This is a simplification + DRY + pattern-conformance pass. Route deeper
structural concerns (layer violations, ownership, concurrency) to a 🔵 SUGG
and defer the larger work.

## The canonical patterns (single source of truth)

When proposing a change, **always cite which canonical pattern the new shape
aligns with**. If a site is already canonical, it stays. If a site diverges
without a documented reason, the proposed shape is "match the canonical
pattern."

### Backend — Python 3.12, FastAPI, Typer, Textual

| Concern              | Canonical home / shape                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider mutation    | `mutation_service.propose_*` → diff → `mutation_service.confirm(...)`. CLI wraps via `cli.confirm.apply_mutation`. |
| Provider read        | Through the `WorkItemProvider` Protocol only. Concrete classes never imported in `core/`, `storage/`, `agent/`, `api/`. |
| Cache write          | Refresh after a confirmed mutation via `mutation_service._refresh_cache`. SQLite is cache, not record.          |
| State translation    | Provider-native ↔ canonical at the `providers/<x>/state_map.py` boundary. The rest of the app uses `ItemKind`, `ItemState`, `TransitionIntent`. |
| Surface adapter      | Thin: parse input → call **one** service → map result. No business logic in routes, commands, or widgets.       |
| Service              | Pure-Python, takes `conn`/`provider`/`paths`/`config` explicitly. No hidden globals. No surface imports.        |
| Repo                 | One repo per aggregate in `storage/repos/`. Surfaces and services call the repo, never raw SQL.                 |
| Agent tool           | Registered in the **fixed order** in `agent/factory.py:build_tool_registry`. Mutating tools stage proposals only. |
| Prompt prefix        | Byte-stable. No timestamps/usernames/scope text before the cache boundary.                                      |
| Read-only mode       | Blocks every mutation entry point and strips mutating tools from the agent + MCP. Not a warning.                |
| API error            | One `HTTPException` shape per category; preserve `raise ... from err` chains; never swallow with bare `except`. |
| Pagination / list    | One canonical response model across list endpoints. No bespoke per-route shapes.                                |
| Path conventions     | `/<resource>/<id>/<sub>`; verbs as POST sub-actions (`/items/{id}/transition`).                                 |
| Config read          | Through `config/` accessors. No re-reading env / TOML in surfaces.                                              |
| Logging              | Structured JSON via `telemetry.logging`. No bare `print`.                                                       |

### Frontend — React 19 + TanStack Start/Router/Query/Form, Bun, Biome, Tailwind

| Concern              | Canonical home / shape                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| API types            | `frontend/src/api/schema.d.ts` — generated from `/openapi.json` via `bun run gen:api`. Hand-typed request/response shapes are a bug. |
| API client           | `frontend/src/api/client.ts`. No bespoke `fetch` calls in components or hooks; route through the client.        |
| Server state         | TanStack Query in `frontend/src/api/hooks.ts` keyed by `frontend/src/api/keys.ts`. **Never** mirror server data into `useState`. |
| Mutations            | `useMutation` in `api/hooks.ts` invalidates the affected `keys.*`. UI surfaces only call the hook.              |
| Routing              | TanStack Router file-based in `frontend/src/routes/**`. No imperative `navigate()` for things a `<Link>` covers. |
| Forms                | `@tanstack/react-form` + the shared form primitives. Class strings live in `frontend/src/lib/formClasses.ts`. No parallel form scaffolding. |
| Component layout     | Feature folders under `frontend/src/components/<feature>/`, co-located handlers (per memory: feature-based UI org). Cross-feature primitives only in `components/common/` or `lib/`. |
| Tailwind classes     | Inline classes are fine. **Three-or-more identical class strings** → one constant in `lib/formClasses.ts` or a sibling. |
| `cn` / class merging | `lib/cn.ts`. No re-implementations.                                                                             |
| Effects              | `useEffect` is the **last** resort. Derived state → `useMemo`/computed; events → handlers; subscriptions → `useSyncExternalStore` or a Query hook. |
| Env access           | `lib/env.ts`. No raw `import.meta.env` reads in components.                                                     |
| Theming / prefs      | `lib/theme.ts`, `lib/uiPrefs.ts`. Surfaces consume; do not re-derive.                                           |
| Loading / error UI   | One canonical pair of components in `components/common/` per shape (skeleton, empty, error). No per-feature copies. |
| Markdown / code      | `react-markdown` + the shared rehype/remark stack. No second markdown renderer.                                 |

### Cross-tree

| Concern              | Canonical                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Source of API truth  | FastAPI route → OpenAPI → `gen:api` → `schema.d.ts`. If frontend types drift, regenerate; never patch by hand.  |
| New endpoint         | Pydantic request + response model → route → regenerate frontend schema → expose via a hook in `api/hooks.ts`.   |
| Magic literals       | Repeated literal in 3+ places → one constant. Backend: `core/` or service-local. Frontend: `lib/` or feature-local. |
| Naming               | Roles, not implementations. `Manager`/`Helper`/`Util` is a smell. `_private` for intra-module-only symbols.     |

## What to look for

For each category below, the proposed shape is **"align with the canonical
pattern above"** unless noted otherwise.

### Cross-cutting (apply to both trees)

- **Rule of three.** Three near-identical sites = extract one primitive at
  the canonical home and migrate callers in the same batch.
- **Pattern divergence.** A site that does the same job a different way than
  the canonical pattern — align it. If divergence is intentional, document
  why in a one-line comment; otherwise conform.
- **Wrappers that forward to a single call.** Inline.
- **Indirection with one implementer and no test seam benefit.** Inline.
- **Dead code, unused params, unreachable branches, commented-out blocks,
  leftover TODOs.** Delete.
- **Compatibility shims.** Project is solo, main-only — delete outright.
- **Comments restating what code says.** Delete; keep only non-obvious *why*.
- **Magic literals repeated in 3+ places.** Lift to one constant.

### Backend (Python 3.12)

- Mutation pipeline boilerplate duplicated across `cli/commands/`,
  `api/routes/mutations.py`, `agent/mutating_tools.py` → one helper, one
  call shape.
- Parallel onboarding/setup logic across `cli/`, `api/routes/setup.py`,
  `config/` → consolidate at the setup-service seam.
- Similar list/show adapters in `cli/commands/` and `api/routes/` → shared
  service that returns a render-ready DTO.
- Hand-rolled helpers where stdlib / Pydantic / Typer / FastAPI built-ins
  cover it (e.g. `datetime` arithmetic, dispatch dicts that should be
  `match`/`enum`, classes that should be functions).
- `Optional` chains where an early return is clearer.
- `Any` / untyped returns where mypy strict accepts a real type.
- `assert` used for runtime validation.
- Broad `except Exception` swallowing real errors; missing `raise … from err`.
- Module-public names with only intra-module callers → `_private`.
- Connections opened inline instead of receiving `conn` from the caller.
- Re-export modules that blur the import boundary → import from canonical home.

### Frontend (React + TanStack + Bun + Biome)

- Components calling `fetch` directly → route through `api/client.ts` or a
  hook in `api/hooks.ts`.
- Hand-typed request/response interfaces that duplicate `schema.d.ts` →
  delete; import the generated type.
- `useState` mirroring server data → delete; read from the Query hook.
- `useEffect` doing derived state, sync, or event handling → replace with
  `useMemo`, props/context, or an event handler.
- Three-or-more identical Tailwind class strings → one constant in `lib/`.
- Per-feature reimplementations of skeleton / empty / error / button /
  input → use the canonical primitive in `components/common/` or `lib/`.
- Imperative `navigate()` where `<Link>` would do.
- Form components that bypass `@tanstack/react-form` and the shared
  primitives → conform.
- Components that re-derive theme/env/prefs instead of using `lib/`.
- Files that mix data fetching, mutation, and presentation in one
  component → split: hook (`use…`) for data, presentation component for UI,
  per CLAUDE.md feature-based organization.
- Files larger than ~250 lines or components with more than ~3 hooks-worth
  of state → split along the natural seam (per memory: pane/feature
  co-location).
- React Fast Refresh hostility (mixing components and non-components in one
  file) — already bit us; flag any recurrence.
- Biome warnings ignored or `// biome-ignore` without a *why* — fix or
  document the reason.
- `any` / `unknown` cast chains where the generated type would suffice.

### API contract (cross-tree)

- New / changed FastAPI routes without a regenerated `schema.d.ts` →
  regenerate and update consuming hooks in the same batch.
- Inconsistent response envelopes across list endpoints → align with the
  canonical list shape.
- 200-with-error-payload patterns → use proper HTTP status codes.
- Request/response models defined inline in route bodies → lift to a
  module-level Pydantic class so the OpenAPI schema is stable and
  refactor-safe.
- Routes that bypass services and call repos directly → route through the
  service layer.

## Preserve intentionally

Load-bearing by design. Do not propose changes that alter:

- the provider import boundary (`core/`, `storage/`, `agent/`, `api/` must
  not import concrete providers)
- the proposal-first mutation pipeline
  (`mutation_service.propose_* → confirm`)
- canonical enums at the boundary
  (`ItemKind`, `ItemState`, `TransitionIntent`)
- byte-stable prompt prefix (`agent/prompt.py`) and the fixed tool
  registration order (`agent/factory.py:build_tool_registry`)
- SQLite-as-cache with refresh-after-write invariant
- explicit context threading (`conn`, `provider`, `paths`, `config`) — no
  hidden globals
- read-only mode guards on every mutation entry point and the stripping of
  mutating agent + MCP tools
- watchlist row independence from `items(id)`
- prompt hot reload, conversation compaction, external update injection,
  bootstrap app split, per-project MCP rebind
- the OpenAPI contract as the single source of frontend types
  (`schema.d.ts` is generated, never hand-edited)
- TanStack Router's file-based route convention in `frontend/src/routes/`
- anything else in CLAUDE.md's "Non-Negotiable Rules" or "Global Invariants"
- architecture tests:
  `tests/unit/test_import_boundary.py`,
  `tests/unit/test_state_map_reverse.py`,
  `tests/unit/test_tool_registration_order.py`,
  `tests/integration/test_github_stub_provider.py`,
  `tests/integration/test_cli_read_only.py`,
  `tests/integration/test_api_read_only.py`,
  `tests/pilot/test_read_only_mode.py`,
  `tests/integration/test_prompt_loader.py`

## Safety rules

- Before removing, renaming, inlining, or consolidating, check every call
  site (`rg` for backend; `rg` plus the TS importer graph for frontend —
  Biome / `tsc --noEmit` will catch the rest).
- If a symbol's purpose is unclear, mark it **needs clarification** and
  move on.
- Prefer reshaping toward an existing canonical pattern over inventing a
  new abstraction. Rule of three before extraction.
- Standing test: *would a typical Python / FastAPI / Typer / Textual
  developer — or a typical React / TanStack / Tailwind developer — write it
  this way?*
- Backend ↔ frontend changes that share a contract (a route signature, a
  response shape) ship in the **same batch**: route + Pydantic model +
  regenerated `schema.d.ts` + hook update.
- No opportunistic reformatting. Every changed line traces to a listed
  finding.
- Never hardcode production config in tests, fixtures, or sources — use
  neutral placeholders (`contoso`, `acme`, `example-resource`).

## Output format

Plan grouped by priority. Under each priority, sub-group findings by the
**What to look for** category they map to. Backend, frontend, and
cross-tree findings are interleaved by priority — do not segregate by tree.

### High-value, low-risk

Clear complexity reduction with minimal behavioral risk and small blast
radius. Eligible for aggressive execution under the workflow below.

### Medium-value or moderate-risk

Meaningful simplification but touches multiple call sites, both trees, or
crosses module boundaries. Requires explicit user go-ahead before applying.

### Strategic / high-risk

Larger shifts (collapsing a service layer, merging route modules, swapping
a frontend library, overhauling setup). Name them for the record; do not
apply in the same pass. Include a one-line "why not now" note.

### Needs clarification

Ambiguous intent, docs-vs-code disagreement, or dependent on project
direction. Ask.

For each finding:

- **Affected file(s)** — absolute-from-repo paths with line numbers
- **Tree** — backend / frontend / cross-tree
- **Category** — which "What to look for" bucket it belongs to
- **Canonical pattern** — which row in "The canonical patterns" table the
  proposed shape aligns with (or "new primitive" if extracting)
- **Current shape** — one or two sentences
- **Proposed shape** — what should change, which idiom / primitive to
  align with
- **Why** — the simplification + DRY benefit
- **Blast radius** — files / call sites / tests / generated artifacts
  likely to move (call out `schema.d.ts` regeneration explicitly)
- **Risk** — low / medium / high
- **Verification** — which gate commands to re-run; manual checks where
  needed (UI smoke for visible frontend changes — start the dev server
  and exercise the feature)
- **Touches a non-negotiable?** — if so, stop and escalate instead of
  proposing

Top-level sections:

- **Do not touch** — items reviewed and deliberately left alone, one-line
  reason each
- **Conflicts between docs and code** — flag only; do not resolve
- **Flagged issues** inline:
  - 🔴 BUG — correctness, data loss, or invariant-break risk
  - 🟡 WARN — smell likely to cause future bugs or drift
  - 🔵 SUGG — opportunity, no immediate risk

## Execution workflow (aggressive cleanup mode)

When the user has authorized aggressive cleanup, execute the plan in
batches under strict verification gates. Otherwise stop after the plan.

Log path convention: `.agent-logs/simplify-<scope>-<batch>-<step>-<YYYYMMDD>.log`,
where `<scope>` is `backend`, `frontend`, `both`, or a module slug. Re-runs
on the same day append a numeric suffix.

1. **Baseline.** Run the gates appropriate to the scope and `tee` each into
   `.agent-logs/simplify-<scope>-baseline-<YYYYMMDD>.log`. If any are red,
   fix or flag before starting — do not layer simplifications onto a
   broken baseline.

   - **Backend gates:**
     `uv run ruff check .` →
     `uv run ruff format --check .` →
     `uv run mypy src` →
     `uv run pytest`
   - **Frontend gates** (in `frontend/`):
     `bun run lint` →
     `bun run typecheck` →
     `bun run build` →
     `bun test` (if applicable)
   - **Cross-tree shortcut:** `make check` runs the unified set.
   - **Contract drift check** (cross-tree changes only): start the API,
     run `bun run gen:api`, confirm `git diff frontend/src/api/schema.d.ts`
     is empty before declaring baseline green.

2. **Batch** high-value, low-risk findings into small, related groups
   (5–10 changes, or one logical seam). Each batch is independently
   shippable and revertible. Cross-tree contract changes (route + schema +
   hook) ship as a single batch.

3. **For each batch:**
   - List the findings being applied with paths and line references and
     the canonical pattern each aligns with.
   - Apply changes surgically. Every changed line traces to a listed
     finding. No drive-by reformatting.
   - Run the gate set for the touched tree(s); pipe each through `tee` into
     `.agent-logs/simplify-<scope>-batch<N>-<step>-<YYYYMMDD>.log`.
   - For visible frontend changes, do a UI smoke pass (dev server +
     exercise the feature) before declaring the batch green. Type-checks
     verify code correctness, not feature correctness.
   - For cross-tree contract changes, regenerate `schema.d.ts` and confirm
     the hook + consumers compile.
   - If a gate fails, stop, diagnose root cause, and fix. Do not bypass
     hooks or skip checks. If the fix balloons past the batch, revert and
     re-plan.
   - After all gates pass, summarize: what changed, gate results, remaining
     blast radius, generated artifacts updated.

4. **Medium-value batches** only after explicit user go-ahead, even in
   aggressive mode. Same gate discipline.

5. **Never touch** anything in "Preserve intentionally" or "Do not touch".
   Aggressive mode is not a license to rewrite load-bearing code.

6. **Stop conditions.** Halt and report back if:
   - a gate fails twice on the same batch,
   - a proposed change reveals a strategic / high-risk shift once begun,
   - a finding surfaces a 🔴 BUG outside the cleanup scope,
   - the plan runs out of high-value, low-risk items (this is a successful
     termination — say so).

7. **Final pass.** On session end, produce a short changelog:
   - batches applied (one line each, with the canonical pattern enforced)
   - batches deferred and why
   - remaining findings by priority
   - suggested scope for the next pass (e.g. "next: `frontend/src/components/items/`
     — three duplicate skeleton variants")

Destructive or cross-boundary actions (removing modules with external
callers, changing schema versions or persistence keys, renaming public
types, breaking the API contract without coordinated frontend changes)
still require explicit confirmation regardless of mode.
