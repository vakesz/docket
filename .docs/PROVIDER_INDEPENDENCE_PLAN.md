# Provider-Independence Refactor — Plan & Decisions

> Living plan for the multi-phase refactor that decouples Docket from its
> three built-in providers (`azure_devops`, `github`, `github_stub`) so adding
> Jira (or any other backend) is a contained, additive change. Each phase
> below is checkpoint-able: complete a phase, run `make check`, commit to
> `main`, then resume from the next.
>
> **Status (2026-04-26):** Phases 0–6 have landed. A follow-up refactor
> generalized Phase 5's `ScopeFilters` into a richer `SavedView` model
> (multi-value facets, state buckets, session overrides, per-project facet
> visibility config). The Phase 5 section below documents the original
> intermediate shape — read it for historical context, then see
> `core/model.py:SavedView` / `core/model.py:ScopeFilters` and
> `core/services/visual_filter.py` for the current contract. The
> authoring guide in [`ADDING_A_PROVIDER.md`](ADDING_A_PROVIDER.md) is the
> single source of truth for new-provider authors.

## Goals

- Adding a new provider should be a fully additive change: drop in a new
  `providers/<type>/` package, register it, no edits required to `core/`,
  `agent/`, `api/`, `cli/`, `cli/tui/`, `frontend/`.
- The architecture tests (`tests/unit/test_import_boundary.py`) keep passing
  — concrete-provider modules stay quarantined behind the spec/registry.
- The web wizard, the TUI settings modal, the CLI `setup` flow, and the live
  settings surface all read provider metadata from the registry; no
  hardcoded `match type_id:` ladders survive.
- Scope filters become provider-defined, not ADO-shaped. Every leak in the
  five-row `TODO.md` table closes; new leaks discovered along the way also
  close.

## Five leaks under attack (TODO.md table)

| # | File:line | Leak | Phase |
|---|-----------|------|-------|
| 1 | `src/docket/config/provider_crud.py:69-97` | `match type_id:` with hardcoded prompts | Phase 3 |
| 2 | `src/docket/cli/tui/widgets/settings_modal.py:159, 230, 441` | TUI settings modal hardcodes ADO fields | Phase 2 |
| 3 | ~~`src/docket/api/routes/setup.py:301-396` + `api/schemas/setup.py:131-176` + `config/setup_discovery.py`~~ | ~~Per-provider discovery routes/schemas~~ | ✅ Phase 4 |
| 4 | `src/docket/config/setup_utils.py:85-103` | `build_label_suggestion()` if-ladder | Phase 1 |
| 5 | `src/docket/config/setup_wizard.py:615-631` | `_WIZARDS` hardcoded trios | Phase 3 |

Additional leaks discovered while researching:

- `src/docket/config/setup_wizard.py` imports concrete `AzureDevOpsProvider`,
  `gh_ensure_logged_in`, `gh_signed_in_email`, `discover` directly (lines
  64-69) — closed in Phase 3.
- `_azure_devops_count_items_for_scope` (lines 590-596) directly
  instantiates `AzureDevOpsProvider` — closed in Phase 3 (CLI scope-count
  reuses `api/_provider_setup.count_items_for_scope`).
- `src/docket/core/model.py:37-51` `ScopeFilters` is ADO-shaped (`team`,
  `area_path`, `iteration_path`) — closed in Phase 5.
- `frontend/src/components/setup/{ProviderStep,ScopeStep,ReviewStep,types}.tsx`
  branches on `type === "azure_devops"` / `"github"` — partially closed in
  Phase 2 (extract per-provider components reused by ProvidersPanel) and
  fully closed in Phase 5 (axis-driven scope step).

## Locked decisions

- **Per-provider React components.** Wizard already has `<AzureConnection>`,
  `<GithubConnection>`, `<GenericConnection>`. We keep that boundary and
  reuse the same components inside the new `ProvidersPanel`.
- **Surface in settings.** Live editing of provider entries goes into the
  existing `/settings` route (TanStack route already mounted) — not a new
  route. New section: `<ProvidersPanel>`.
- **Phase 5 (scope axes) ships regardless of Jira readiness.** It's the
  deepest leak (`ScopeFilters` in `core/model.py`) and unblocks every
  future provider, not just Jira.
- **Phase-by-phase commits on `main`.** Solo, unreleased, no PR review
  loop. After each phase: `make check`, commit, mark task complete.
- **Hard delete the old per-provider discovery routes** when Phase 4 lands.
  No deprecation window — the SPA cuts over in the same commit.
- **`provider_crud.provider_add` keeps its interactive `Prompt.ask` flow.**
  Don't shoehorn it into the wizard hook registry; it's a CLI-only flow.
- **`cli/commands/setup.py:52` `--type` default is `github`** (was
  `azure_devops`). Both CLI and SPA wizard land on github first. ✅ landed
  in Phase 0.
- **Discovery row shape is canonical.** Define
  `DiscoveryItem(value: str, label: str, extras: dict[str, str] = {})`
  in `src/docket/api/schemas/setup.py`. All providers normalize their
  discovery output to this shape. Drops the per-provider DTO sprawl in
  `schema.d.ts`.

## Open questions / future decisions

- **Jira readiness.** Not decided. Phases 1-6 don't depend on Jira existing
  — they make it possible. The first actual Jira PR is a separate effort
  on top of this refactor.
- **`pick_github_host` / `pick_github_repo`** Move into
  `providers/github/setup.py` (Phase 3) so the github plugin owns its CLI
  prompts, just like ADO.

---

## Phase 0 — pin behavior with tests ✅ landed

**Goal:** before any refactor, lock in current behavior so we can detect
regressions phase by phase.

**Tasks:**
1. Extend `tests/integration/test_setup_wizard.py` with end-to-end coverage
   for **GitHub** and **github_stub** wizard paths (currently only ADO).
   Use the same `_script_prompts(...)` deque pattern.
2. New `tests/unit/test_provider_setup_hooks.py` — smoke test that asserts
   every built-in `registry.specs()` entry has `factory`, `setup_fields`
   tuple, and `grouping`. Post-Phase 1 we extend it to assert
   `label_template`. Post-Phase 3 we extend it to assert each spec has a
   registered setup hook (currently a TODO line).
3. Placeholder `tests/integration/test_api_setup_discover_generic.py` with
   `pytest.mark.xfail(strict=True)` for the future
   `POST /api/setup/providers/{type_id}/discover` route. Removes once
   Phase 4 implements it.

**Exit criteria:**
- `uv run pytest tests/integration/test_setup_wizard.py tests/unit/test_provider_registry_grouping.py tests/unit/test_provider_setup_hooks.py` is green.
- `uv run pytest tests/integration/test_api_setup_discover_generic.py` xfails (or the file is skipped pending Phase 4).
- Commit message: "test: pin wizard + spec behavior before provider-independence refactor".

---

## Phase 1 — `label_template` on `ProviderSpec` ✅ landed

**Status:** completed. `setup_utils.build_label_suggestion` is now a
registry walker over `ProviderSpec.label_template`; `signed_in_github_host`
and the `github_host` field on `SuggestLabelRequest` are gone (host derived
from `base_url` in config). `tests/unit/test_provider_setup_hooks.py` pins
template outputs per built-in.

**Goal:** delete the `if/elif/else` ladder in
`src/docket/config/setup_utils.py:85-103` (`build_label_suggestion`).

**Plan:**
1. Add `label_template: Callable[[Mapping[str, str]], str] | None` to
   `ProviderSpec` (`src/docket/providers/base.py`).
2. Built-ins inline their templates in `_register_builtins()`
   (`src/docket/providers/registry.py`):
   - `azure_devops`: `f"{org} / {project}"` from config keys.
   - `github`: read `base_url` (already in config dict for GHE hosts) →
     pretty domain + (optional) repo. Drop the `github_host_hint` parameter
     from `SuggestLabelRequest`/`build_label_suggestion`.
   - `github_stub`: `"github_stub"`.
3. `build_label_suggestion(type_id, config)` becomes a registry walker:
   `spec(type_id).label_template(config) or type_id`.
4. SPA `SuggestLabelRequest` (`api/schemas/setup.py`) drops `github_host`
   field; SPA wizard drops the manual host hint plumbing.

**Exit criteria:**
- `uv run pytest tests/integration/test_api_setup.py tests/unit/test_provider_registry_grouping.py tests/unit/test_provider_setup_hooks.py` green.
- `uv run pytest -k suggest_label` green.
- Smoke test in Phase 0 extended to assert `label_template` non-None for
  every built-in.
- Commit: "refactor: collapse build_label_suggestion behind ProviderSpec.label_template".

---

## Phase 2 — spec-driven TUI + new SPA `ProvidersPanel` ✅ landed

**Status:** completed. `SettingsModal.compose` and `_build_config` now
loop over `registry.spec(...).setup_fields`. The wizard's connection
components moved to `frontend/src/components/setup/connection/` and the
SPA settings `ProviderModal` consumes them via `<ConnectionFields>`,
giving discovery-aware host/repo/org/project pickers in both surfaces.
`ProviderDraft.github_host` deleted; host derived from `config.base_url`.

**Goal:** kill leak #2 (settings modal hardcodes ADO inputs) and surface
provider editing in the SPA `/settings` route.

**TUI side (`src/docket/cli/tui/widgets/settings_modal.py`):**
1. Replace lines 159, 230-242, 441-448 with a loop over
   `registry.spec(provider_type).setup_fields` matching what the SPA
   wizard does in `<ProviderStep>`.
2. Render each `SetupField` as the right Textual input
   (`Input(password=True)` for `kind="secret"`, plain `Input` otherwise).
3. Save path: collect all current `setup_fields` keys into a `dict[str,str]`
   and round-trip through `registry.normalize_config(type_id, config)`
   instead of branching on `entry.type`.

**SPA side (`frontend/src/components/settings/`):**
1. New `ProvidersPanel.tsx` — read `provider-types` DTO, list configured
   providers from `/api/settings/providers`, support add/edit/remove via
   the existing settings routes.
2. Reuse `<AzureConnection>`, `<GithubConnection>`, `<GenericConnection>`
   from `frontend/src/components/setup/ProviderStep.tsx` — extract them
   into `frontend/src/components/setup/connection/` so both wizard and
   settings panel import the same components.
3. Add the panel as a tab/section under `/settings`. Existing TanStack
   route file already mounts the page; this is just a new section under
   it.

**Exit criteria:**
- `uv run pytest tests/pilot/test_settings_modal_pilot.py` (if it exists)
  green; otherwise add a minimal pilot test that opens settings, picks a
  github entry, edits its base_url, saves, asserts config persisted.
- `cd frontend && bun run typecheck && bun run lint` green.
- Manual: `make serve`, browse `/settings`, add and remove a provider
  entry through the SPA.
- Commit: "refactor: spec-driven settings modal + add ProvidersPanel to SPA".

---

## Phase 3 — wizard hook registry + per-provider `setup.py` ✅ landed

**Status:** completed. `src/docket/config/setup_hooks.py` is the new
dispatch boundary; each built-in provider package owns its own
`setup.py` (`providers/{azure_devops,github,github_stub}/setup.py`)
that registers `WizardHooks(auth, connection, scope)` at registry
bootstrap. `setup_wizard.py` no longer imports any concrete provider
symbols. `setup_discovery.py` (now CLI-probes only after Phase 4)
remains the last concrete-import site under `config/` — it stays
because `probe_az`/`probe_gh`/`list_gh_hosts` are about the local CLI
session, not an active provider, and pulling them under `providers/`
would require a separate `WizardHooks.probe_session` axis.
`provider_crud.py` now collects fields generically from
`spec.setup_fields`. Tests assert hook registration parity with the
spec registry.

**Goal:** kill leak #5 (`_WIZARDS`) and leak #1 (`provider_crud.match
type_id:`); remove concrete-provider imports from
`src/docket/config/setup_wizard.py`.

**Plan:**
1. New `src/docket/config/setup_hooks.py`:
   ```python
   @dataclass(frozen=True)
   class WizardHooks:
       auth: Callable[["WizardState"], None]
       connection: Callable[["WizardState"], None]
       scope: Callable[["WizardState"], None]
       count_items: Callable[[ProviderEntry, ScopeFilter, ProvidersConfig], int | None]
       label_prompt: Callable[[Mapping[str, str]], str] | None  # optional CLI default

   _hooks: dict[str, WizardHooks] = {}
   def register(type_id: str, hooks: WizardHooks) -> None: ...
   def get(type_id: str) -> WizardHooks | None: ...
   ```
2. New `src/docket/providers/azure_devops/setup.py` — owns the ADO auth /
   connection / scope / count callables. Calls
   `setup_hooks.register("azure_devops", ...)` at import time.
3. New `src/docket/providers/github/setup.py` — same shape; also takes
   `pick_github_host` and `pick_github_repo` from `setup_utils.py`.
4. New `src/docket/providers/github_stub/setup.py` — minimal scope/auth.
5. `providers/__init__.py` (or `providers/registry.py:_register_builtins`)
   imports each `setup.py` so registration is a side effect of registry
   bootstrap.
6. `src/docket/config/setup_wizard.py`:
   - Drop the direct imports of `AzureDevOpsProvider`,
     `gh_ensure_logged_in`, `gh_signed_in_email`, `discover`.
   - Replace `_WIZARDS` dict with `setup_hooks.get(type_id)` lookups in
     `_step_provider_auth`, `_step_provider_connection`, `_step_provider_scope`.
   - `_azure_devops_count_items_for_scope` becomes
     `_count_items_for_scope(entry, scope, providers_cfg)` calling
     `setup_hooks.get(entry.type).count_items(...)`.
7. `src/docket/config/provider_crud.py:69-97` — replace `match type_id:`
   with a generic loop over `spec(type_id).setup_fields`. `Prompt.ask`
   each field; mark `kind="secret"` as `password=True`.

**Exit criteria:**
- `tests/unit/test_import_boundary.py` still asserts no concrete-provider
  imports under `src/docket/config/` (extend the test if it doesn't).
- `tests/unit/test_provider_setup_hooks.py` extended to assert every spec
  has a registered hook; no spec is missed.
- `tests/integration/test_setup_wizard.py` green for all three providers.
- Phase 0 tests still pass.
- Commit: "refactor: per-provider setup.py modules + wizard hook registry".

---

## Phase 4 — generic discovery endpoint ✅ landed

**Status:** Discovery is now stage-driven through one route.

- `WizardHooks` grew a `discover: DiscoverFn | None` field; each
  provider's `setup.discover_step(stage, payload)` returns
  `list[DiscoveryItem]` (`config/setup_hooks.py`). ADO maps
  `orgs|projects|teams|areas|iterations`; GitHub maps
  `hosts|repos|orgs|org_repos` (host stage emits `extras.api_base_url`);
  `github_stub` returns `[]` for known stages and `ValueError` otherwise.
- Old per-provider routes (`/setup/azure-devops/discover`,
  `/setup/github/discover`) and their DTOs (`AdoDiscoverRequest`,
  `GithubDiscoverRequest`, `AdoOrgDTO`, `GithubRepoDTO`, etc.) deleted.
  New: `POST /api/setup/providers/{type_id}/discover` with
  `DiscoverRequest{stage, payload}` → `DiscoverResultDTO{ok, error,
  items: [DiscoveryItemDTO{value, label, extras}]}`.
- `setup_discovery.py` shrunk to just CLI-status probes (`probe_az`,
  `probe_gh`, `list_gh_hosts`, `CliToolStatus`); the
  `ado_list_*`/`gh_list_*` shims are gone now that the API layer
  reaches discovery through `setup_hooks` instead.
- SPA migrated to `useProviderDiscover(typeId)`; `AzureConnection`,
  `GithubConnection`, and `ScopeStep`'s `AdoAxisField` map
  `items[].value` into form state. `schema.d.ts` regenerated via
  `bun run gen:api`.
- `tests/integration/test_api_setup_discover_generic.py` (placeholder)
  removed; canonical discovery coverage lives in
  `tests/integration/test_api_setup.py` and exercises the route → hooks
  → underlying `discover.list_*` helper path with monkey-patched
  helpers.

**Original plan:** kill leak #3. Replace `/setup/azure-devops/discover`
and `/setup/github/discover` with one route.

**Plan:**
1. New canonical row shape in `src/docket/api/schemas/setup.py`:
   ```python
   class DiscoveryItem(BaseModel):
       value: str
       label: str
       extras: dict[str, str] = Field(default_factory=dict)

   class DiscoverRequest(BaseModel):
       stage: str
       payload: dict[str, str]

   class DiscoverResultDTO(BaseModel):
       ok: bool
       items: list[DiscoveryItem] = Field(default_factory=list)
       error: str | None = None
   ```
2. Add `discover: Callable[[str, dict[str, str]], list[DiscoveryItem]] | None`
   on `WizardHooks` (registered alongside auth/connection/scope in each
   `providers/<type>/setup.py`).
3. New route `POST /api/setup/providers/{type_id}/discover` in
   `src/docket/api/routes/setup.py` — looks up `setup_hooks.get(type_id)`,
   calls `.discover(stage, payload)`, returns `DiscoverResultDTO`.
4. Delete the old `/setup/azure-devops/discover` and
   `/setup/github/discover` routes and their schemas (`AdoDiscoverRequest`,
   `GithubDiscoverRequest`, etc).
5. SPA: `frontend/src/api/hooks.ts` — drop `useAdoDiscover`,
   `useGithubDiscover`. Add `useProviderDiscover(typeId, stage)` that
   calls the new endpoint. Update `<ProviderStep>` and `<ScopeStep>`
   accordingly.
6. `cd frontend && bun run gen:api` to regenerate `schema.d.ts`.

**Exit criteria:**
- `tests/integration/test_api_setup_discover_generic.py` un-xfail-ed and
  green.
- Existing `test_api_setup.py` tests for ADO/GitHub discovery rewritten
  to use the new route.
- SPA wizard end-to-end smoke (`pilot` or manual) confirms pickers still
  populate.
- Commit: "refactor: collapse per-provider discovery into /api/setup/providers/{type_id}/discover".

---

## Phase 5 — per-provider scope axes ✅ landed (later superseded)

> The Phase 5 shape described below shipped as written, then a follow-up
> refactor generalized it into `SavedView` (multi-value `axes`,
> `assignees`, and a `state_bucket` literal) plus `ScopeFilters` (the
> resolved runtime tuple consumed by `core/services/visual_filter.py`).
> Sync no longer accepts a filters argument at all — every dimension is
> a *visual* filter applied post-cache. The historical plan stays here
> for context; current code is in `src/docket/core/model.py`,
> `src/docket/config/models.py:SavedView`, and
> `src/docket/core/services/visual_filter.py`.

**Goal:** kill the deepest leak — `ScopeFilters` in
`src/docket/core/model.py` is ADO-shaped (`team`, `area_path`,
`iteration_path`).

**Plan:**
1. `src/docket/core/model.py` — `ScopeFilters` becomes:
   ```python
   @dataclass(frozen=True)
   class ScopeFilters:
       assignee: str = ""
       axes: Mapping[str, str] = field(default_factory=dict)
   ```
   `team` / `area_path` / `iteration_path` move into `axes` keyed by
   axis name.
2. `src/docket/config/models.py` — `ScopeFilter` Pydantic mirror picks up
   the same shape. Migration: existing config TOML files under
   `[providers.<key>.scope]` already use these keys → loader maps known
   keys into `axes` for backward compat in this commit only, then we
   delete that compat in Phase 6 since this is unreleased solo software.
3. New `scope_axes: tuple[ScopeAxis, ...]` on `ProviderSpec`:
   ```python
   @dataclass(frozen=True)
   class ScopeAxis:
       key: str             # "team", "area_path", "host" — provider-defined
       label: str           # "Team", "Area path", "GitHub host"
       discovery_stage: str | None = None  # if not None → datalist via discover
       supports_assignee: bool = True
   ```
4. ADO spec declares `scope_axes=(ScopeAxis("team", "Team", "teams"),
   ScopeAxis("area_path", "Area path", "areas"),
   ScopeAxis("iteration_path", "Iteration path", "iterations"))`.
   GitHub declares `scope_axes=()` (only assignee). Future Jira can
   declare `("project", "Project", "projects")` etc.
5. `src/docket/cli/visual_filter.py` reads axes from spec, not by name.
   `where = WhereClauseBuilder(provider_key, scope_filters.assignee,
   scope_filters.axes)` — axes are matched against canonical column names
   that the provider already populates.
6. SPA `ScopeStep.tsx` — replace `<AdoScopeFields>` with a generic loop
   over `provider_type_dtos[type].scope_axes`, calling discovery via the
   Phase 4 generic endpoint when `discovery_stage` is set.
7. SPA `types.ts:scopeToWire` — drop the `if (type === "azure_devops")`
   branch; serialize `axes` directly.
8. `tests/unit/test_visual_filter.py` extended to cover an axis-driven
   github_stub provider with custom axes.

**Exit criteria:**
- `uv run pytest` green across all suites.
- SPA scope step works end-to-end for ADO, GitHub, github_stub.
- Add a `test_scope_axes.py` unit test that defines a fake provider with
  custom axes and confirms the wizard surfaces them — proves no built-in
  blessed paths remain.
- Commit: "refactor: provider-defined scope axes (drop ADO-shaped ScopeFilters)".

---

## Phase 6 — `.docs/ADDING_A_PROVIDER.md` ✅ landed

**Goal:** document the additive path so future-us (or a contributor) can
add Jira / Linear / etc. without re-deriving the architecture.

**Sections:**
1. **Overview / decision tree** — when do you actually need a new
   provider vs. an MCP server? (rough rule: native CRUD + scope axes →
   provider; read-only adjunct → MCP.)
2. **File layout.** Show the canonical `providers/<type>/` package:
   `__init__.py`, `provider.py`, `state_map.py`, `auth.py`, `discover.py`,
   `field_map.py`, `setup.py` (the wizard hook registration). Each file's
   role in one paragraph.
3. **Implementing `WorkItemProvider`.** List the 6 methods
   (`fetch_list`, `fetch_detail`, `transition`, `patch_description`,
   `upload_attachment`, `create_item`); for each, what canonical types it
   takes + returns. Pointer to `tests/fakes/provider.py` as a reference
   impl.
4. **State map.** Why `ItemState` / `TransitionIntent` exist and how
   `state_map.py` maps both directions. Mention the
   `tests/unit/test_state_map_reverse.py` round-trip guard.
5. **`ProviderSpec`.** Walk through `setup_fields`,
   `normalize_config`, `requires_cli`, `grouping`, `label_template`,
   `scope_axes`. Show a copy-pasteable spec block.
6. **Wizard hooks.** Show `setup_hooks.register(type_id, WizardHooks(
   auth=..., connection=..., scope=..., count_items=..., discover=...))`.
   Give a minimal `auth` impl that's just a sanity check.
7. **Discovery.** How the generic `discover(stage, payload)` callback
   works; what `DiscoveryItem.extras` is for; example with two stages.
8. **Scope axes.** When to add an axis, when not. Mapping axis values to
   query columns the provider already populates.
9. **Registration.** Two paths: in-tree (edit
   `providers/registry.py:_register_builtins`) or as a third-party
   plugin via `docket.providers` entry-point group. Pyproject snippet for
   the entry-point.
10. **Testing checklist.** What to add: `test_<type>_provider.py`
    (round-trip via FakeProvider pattern), `test_state_map_reverse.py`
    membership, `test_setup_wizard.py` end-to-end, `test_provider_setup_hooks.py`
    membership, optional `test_api_setup_discover_generic.py` case.
11. **End-to-end verification.** `make check`, `make serve`, walk
    through the wizard, mint config, list items, transition one, sync.

**Exit criteria:**
- File exists at `.docs/ADDING_A_PROVIDER.md`, ~400-700 lines including
  code blocks.
- Cross-link from `README.md` (under "Providers") and from `AGENTS.md`
  (under the architecture map).
- Commit: "docs: add provider authoring guide".

---

## Quick recovery checklist

If we lose context mid-refactor, this is the order to re-orient:

1. `git log --oneline -20` — find the last "refactor:" or "test:" commit.
2. `cat .docs/PROVIDER_INDEPENDENCE_PLAN.md` (this file).
3. `make check` — see what's currently green.
4. `uv run pytest tests/unit/test_import_boundary.py tests/unit/test_state_map_reverse.py tests/unit/test_tool_registration_order.py tests/unit/test_provider_setup_hooks.py` — architectural guards.
5. Pick up at the next phase whose prior commit landed.

## Key invariants preserved across all phases

- Architecture tests stay green: no new concrete-provider imports under
  `core/`, `agent/`, `api/`, `storage/`, `config/setup_*`.
- Prompt prefix stays byte-stable: nothing in this refactor touches the
  agent factory's tool registration order.
- SQLite is still a cache, mutation gate still routes through
  `core/services/mutation_service.py`. None of these phases touches the
  mutation surface.
- Read-only mode still strips mutating tools and blocks every mutation
  endpoint.
