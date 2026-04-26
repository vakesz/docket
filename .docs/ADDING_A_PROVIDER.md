# Adding a Provider to Docket

This guide walks through everything you need to wire a new work-item backend
(Jira, Linear, anything else) into Docket without touching the surfaces that
consume it. The pattern is **strictly additive** — the CLI, TUI, FastAPI
routes, and React SPA all dispatch through the registry, so a new provider
package + a few registry calls is enough.

If you find yourself editing `core/`, `agent/`, `api/`, or `frontend/` to
land a provider, stop and re-read this — that's a leak we just spent five
phases closing.

---

## 1. Provider or MCP server?

Two integration shapes, both real, easy to confuse:

| You want… | Use a |
| --- | --- |
| Native CRUD (transition, patch description, create item) on the canonical model, with view-time filtering, sync, and proposal-first writes. | **Provider** (this guide). |
| Read-only adjunct that the agent calls as a tool — search, fetch, etc. — without participating in the SQLite cache or proposal flow. | **MCP server** (`src/docket/agent/mcp/`, configured per project in `config.toml`). |

If your data isn't a work item (incident timelines, runbooks, dashboards),
you almost always want MCP. If it *is* a work item but you only need
read-only access, you can still get away with MCP — Docket already has a
mature MCP fleet manager. Pick a provider when you genuinely need write
support and want the items folded into the unified backlog tree.

---

## 2. Package layout

Built-in providers live under `src/docket/providers/<type_id>/`. The
canonical layout (mirrors `azure_devops/` and `github/`):

```
src/docket/providers/<type_id>/
├── __init__.py        # empty or re-exports; not load-bearing
├── auth.py            # ensure_logged_in() + signed_in_email() — touches the CLI/SDK
├── discover.py        # list_orgs/list_repos/etc — pure data, raises DiscoveryError
├── field_map.py       # (optional) provider field name → canonical field
├── provider.py        # WorkItemProvider implementation
├── scope.py           # (optional) axis_matcher + axis_extract for view-time facet filtering
├── setup.py           # WizardHooks: auth/connection/view/discover callbacks
└── state_map.py       # provider-native state ↔ canonical ItemState/TransitionIntent
```

Third-party providers don't have to follow this layout — only the
`WorkItemProvider` Protocol + the `ProviderSpec` registration are required.
The split exists so each file has one job; copying it is the path of least
resistance.

| File | Job |
| --- | --- |
| `provider.py` | The class implementing `WorkItemProvider`. No Rich, no Confirm prompts — just data in, canonical types out. |
| `state_map.py` | Two pure functions: `to_canonical(native_state) -> ItemState` and `to_native(intent: TransitionIntent) -> str`. Round-trip pinned by `tests/unit/test_state_map_reverse.py`. |
| `auth.py` | Side-effecting login probe. Imports `keyring`, `subprocess`, the SDK — whatever it takes. Imported by `setup.py`, never by `provider.py`. |
| `discover.py` | Pure-ish lookups (orgs, projects, repos, paths). Raises `DiscoveryError` (subclass of `ProviderError`) on failure. Used by both the CLI wizard prompts and the SPA's `/discover` endpoint. |
| `setup.py` | The wizard's per-provider hook table. Imports Rich + the discover/auth helpers. Calls `setup_hooks.register(type_id, WizardHooks(...))`. |
| `scope.py` | Optional `axis_matcher(item, axis_key, expected) -> bool` plus `axis_extract(item, axis_key) -> str | None` for any provider that declares `scope_axes`. Lives separately from `provider.py` so `core/`'s view-time filter stays SDK-free. |
| `field_map.py` | Optional canonicalization helpers — handy for providers with weird per-field shapes (HTML descriptions, custom-field UUID indirection, etc.). |

---

## 3. Implement `WorkItemProvider`

The Protocol lives in `src/docket/providers/base.py`. Every method takes
canonical types in (`ItemKind`, `ItemState`, `TransitionIntent`,
`CreateFields`) and returns canonical types out (`Item`, `Comment`).
Provider-native enums and field names never escape. **Sync is
unconstrained** — `list_changes_since` takes a watermark only. Every
narrowing dimension (assignee, state bucket, provider scope axes) is a
*visual* filter applied to cached items via `core/services/visual_filter.py`.

```python
class WorkItemProvider(Protocol):
    def health_check(self) -> None: ...

    def list_changes_since(self, watermark: datetime | None) -> Iterable[Item]: ...

    def get_item(self, id: str) -> Item: ...
    def get_comments(self, id: str) -> list[Comment]: ...
    def get_linked(self, id: str) -> list[Item]: ...

    def transition(self, id: str, intent: TransitionIntent) -> Item: ...
    def patch_description(self, id: str, new_md: str) -> Item: ...
    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str: ...
    def add_comment(self, id: str, body_md: str) -> Comment: ...
    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item: ...

    # Optional but recommended — enables the @me visual filter.
    def current_user_identity(self) -> str | None: ...
```

Reference impls:
- `tests/fakes/provider.py:FakeProvider` — the smallest possible Protocol-
  satisfying provider used by the test suite. Read this first.
- `src/docket/providers/github_stub/provider.py` — in-memory stub close
  to a real provider in shape but without network calls.
- `src/docket/providers/github/provider.py` — production reference.

**Items must carry `provider_key`** when returned from `list_changes_since`
or `fetch_items`. Sync upserts use it to scope the cache to the right
provider entry. The repos do this for you when you call `upsert_item`, but
read paths that bypass the repo (rare) need to stamp it.

**`Item.provider_raw`** is the right place to stash provider-native fields
your `axis_matcher` will read (see §6). Never expose them to surfaces
directly.

---

## 4. State map

Canonical states live in `src/docket/core/model.py`:

```python
class ItemState(StrEnum):
    NEW = "new"
    ACTIVE = "active"
    BLOCKED = "blocked"
    NEEDS_INFO = "needs_info"
    RESOLVED = "resolved"
    CLOSED = "closed"

class TransitionIntent(StrEnum):
    START_WORK, PAUSE, BLOCK, NEEDS_INFO, CLOSE_DONE, CLOSE_WONTFIX, REOPEN = ...
```

`state_map.py` exports two functions — one per direction:

```python
def to_canonical(native: str) -> ItemState: ...
def to_native(intent: TransitionIntent) -> str: ...
```

The round-trip is pinned by `tests/unit/test_state_map_reverse.py`: every
`TransitionIntent` must map to a native string that, when read back,
canonicalizes to the right `ItemState` for the resulting transition. Add a
case there for your new provider — it's the cheapest way to catch state-map
typos.

For native states the provider returns that don't fit the canonical
buckets, lean toward `ItemState.ACTIVE` ("in flight") or `ItemState.NEW`
("not started") rather than inventing a new enum value. The agent and the
TUI's by-state-bucket grouping rely on the existing six.

---

## 5. `ProviderSpec`

The spec is the static description of the provider type. Construct one and
hand it to `registry.register(spec)`. Frozen dataclass; immutable.

```python
from docket.providers.base import (
    GroupingStrategy,
    LabelTemplate,
    ProviderSpec,
    ScopeAxis,
    SetupField,
)
from docket.core.model import ItemKind

ProviderSpec(
    type_id="acme",                   # wire id; matches `[providers.<key>.type]`
    display_name="ACME Tracker",
    factory=_acme_factory,            # (config, display_name) -> WorkItemProvider
    requires_cli=("acme-cli",),       # CLI binaries the wizard probes
    setup_fields=(
        SetupField(
            key="endpoint",
            label="ACME endpoint",
            kind="url",               # "string" | "url" | "secret"
            required=True,
            placeholder="https://acme.example.com",
            help="Tenant URL.",
        ),
    ),
    normalize_config=_acme_normalize,    # optional; runs before validate+persist
    label_template=_acme_label,          # optional; default display-name suggestion
    grouping="by_state_bucket",          # or "by_kind" — drives the TUI tree
    supported_kinds=(ItemKind.STORY, ItemKind.TASK, ItemKind.BUG),  # for new-item picker
    scope_axes=(
        ScopeAxis(key="squad", label="Squad", discovery_stage="squads"),
        ScopeAxis(key="component", label="Component"),  # discovery_stage=None → manual entry
    ),
    axis_matcher=_acme_axis_matcher,    # required iff scope_axes is non-empty
    axis_extract=_acme_axis_extract,    # required iff scope_axes is non-empty (for facet popovers)
)
```

**`setup_fields`** drive both the CLI wizard prompts and the SPA's
connection step. The SPA fetches them from `/setup/providers/types`; do
not also hardcode them in React.

**`grouping`** controls how the TUI groups the backlog tree. `"by_kind"`
nests epics → features → stories → tasks → bugs (Azure DevOps). `"by_state_bucket"`
collapses to Open vs Done (GitHub Issues, which doesn't realistically use
the full hierarchy).

**`scope_axes`** declares the provider-defined narrowing axes the visual
filter exposes (in addition to the always-on `assignee` axis). Empty `()`
means assignee is the only axis — the GitHub default. See §6.

**`label_template`** computes the default "display name" from a config dict
(`base_url`, `default_repo`, etc.). The wizard pre-fills the display-name
prompt with this; the SPA's `/suggest-label` returns the same. Skip it for
providers where the bare type id is fine.

---

## 6. Scope axes

Scope axes are how Docket narrows cached items without taking on provider-
specific knowledge in `core/`. They are **visual** (post-cache) filters —
sync always pulls everything the credentials see, and the filter pipeline
in `core/services/visual_filter.py` decides what gets shown. The
`assignee` axis is always present (every provider with assignment supports
it); everything else is declared by the spec.

When to add an axis:
- The provider exposes a stable narrowing dimension users actually filter by
  (team, project area, sprint, squad, component).
- The dimension's value is already in `Item.provider_raw` after sync, or
  cheap to derive from cached fields.

When NOT to add an axis:
- For sort orders or display preferences (those are UI concerns).
- For values that change per-item without a stable enumeration — those
  belong in full-text search, not the chip bar.

Each axis carries:
- `key` — wire id stored in `SavedView.axes` and sent over the SPA wire.
- `label` — rendered to humans in the wizard, settings modal, and SPA.
- `discovery_stage` — when set, names the `WizardHooks.discover` stage
  that lists candidate values for autocomplete. Leave `None` for free-form
  axes (the SPA falls back to a plain text input).

`axis_matcher` is the view-time predicate `core/services/visual_filter.py`
calls for each constrained axis:

```python
def axis_matcher(item: Item, axis_key: str, expected: str) -> bool:
    """Return True iff `item` is in the slice keyed by (axis_key, expected)."""
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    if axis_key == "squad":
        return raw.get("squad") == expected
    if axis_key == "component":
        return raw.get("component") == expected
    return False  # unknown axis → narrow to nothing rather than silently widen
```

Returning `False` on unknown keys (rather than `True`) is the safe default
— a misconfigured filter narrows to nothing instead of silently dropping
the constraint.

`axis_extract` is the dual that powers the chip-bar facet popovers — for
each cached item it returns the canonical value the item carries on that
axis, or `None` when the axis doesn't apply:

```python
def axis_extract(item: Item, axis_key: str) -> str | None:
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return None
    if axis_key in ("squad", "component"):
        value = raw.get(axis_key)
        return value if isinstance(value, str) and value else None
    return None
```

Both `axis_matcher` and `axis_extract` are required when `scope_axes` is
non-empty. The ADO pair in `src/docket/providers/azure_devops/scope.py`
is the canonical example.

---

## 7. Wizard hooks

Per-provider onboarding lives in the `WizardHooks` registered against the
type id. The dispatcher (`config.setup_wizard`) calls them when the user
selects a provider in `docket setup`; the SPA hits them through `/setup/*`.

```python
from docket.config.setup_hooks import (
    DiscoveryItem, WizardHooks, register as register_hooks,
)

def step_auth(state: WizardState) -> None:
    """Probe for a live session; raise if the user needs to log in."""
    auth.ensure_logged_in()
    state.signed_in_email = auth.signed_in_email()

def step_connection(state: WizardState) -> None:
    """Pick endpoint/project/etc. and stash into `state.provider_config`."""
    endpoint = Prompt.ask("ACME endpoint", default=state.provider_config.get("endpoint", ""))
    state.provider_config = {"endpoint": endpoint}

def step_view(state: WizardState) -> None:
    """Build the default `SavedView` from the spec's axes — see _pick_optional pattern."""
    ...

def discover_step(stage: str, payload: Mapping[str, str]) -> list[DiscoveryItem]:
    """Stage-driven autocomplete data for both CLI pickers and SPA datalists."""
    if stage == "squads":
        return [DiscoveryItem(value=s, label=s) for s in discover.list_squads()]
    raise ValueError(f"unknown stage: {stage!r}")

def register() -> None:
    register_hooks(
        "acme",
        WizardHooks(
            auth=step_auth,
            connection=step_connection,
            view=step_view,
            discover=discover_step,
        ),
    )
```

Any of `auth`, `connection`, `view` may be `None` — the wizard falls
through to a sensible default. `discover` may also be `None`, in which case
the SPA's discovery datalist is empty and the user falls back to free-form
input. (The Azure DevOps and GitHub setup modules are good copy-paste
templates: `src/docket/providers/azure_devops/setup.py`,
`src/docket/providers/github/setup.py`.)

`tests/unit/test_provider_setup_hooks.py` asserts that every spec in the
registry has a matching hook entry. Forgetting `register()` will fail this
test.

---

## 8. Discovery

The `discover(stage, payload)` callback is the single entry point both the
CLI wizard's pickers and the SPA's datalists hit through
`POST /api/setup/providers/{type_id}/discover`. It's stage-driven so one
callback covers every drop-down a provider needs.

```python
def discover_step(stage: str, payload: Mapping[str, str]) -> list[DiscoveryItem]:
    if stage == "orgs":              # no payload required
        return [DiscoveryItem(value=o.url, label=o.name) for o in discover.list_orgs()]
    if stage == "repos":             # payload = {"org": "..."}
        org = payload.get("org", "").strip()
        if not org:
            raise ValueError("payload.org is required for stage 'repos'")
        return [DiscoveryItem(value=r.full_name, label=r.full_name) for r in discover.list_repos(org)]
    raise ValueError(f"unknown stage: {stage!r}")
```

`DiscoveryItem.value` is what gets persisted (the wire identifier);
`DiscoveryItem.label` is what the user sees. `DiscoveryItem.extras` is a
free-form `Mapping[str, str]` for additional metadata the SPA's connection
component may want — Azure DevOps uses it for the `(org-slug)` annotation
in the org picker. Most providers don't need it.

`ProviderError`/`DiscoveryError` from underlying SDK calls bubbles up; the
route catches them and returns `ok=false` with the human-readable message,
so the SPA can fall back to manual entry without translating exception
types. `ValueError` from unknown stages produces the same `ok=false`
shape.

---

## 9. Registration

Two paths, depending on whether the provider lives in this repo or a
separate package.

**In-tree (built-in):** add a `register(...)` call inside
`_register_builtins()` in `src/docket/providers/registry.py`, plus a
`register_<type>_hooks()` call at the end. The factory closure can live
right there — see how `_azure_devops_factory` is wired.

**Third-party (entry-point):** ship as its own package with a
`docket.providers` entry point that resolves to a no-arg callable doing
the registration:

```toml
# In your provider package's pyproject.toml
[project.entry-points."docket.providers"]
acme = "docket_acme.registry:register"
```

```python
# docket_acme/registry.py
from docket.providers.registry import register
from docket.providers.base import ProviderSpec

def register_acme():
    register(ProviderSpec(type_id="acme", ...))
    # Plus the wizard-hook registration:
    from docket_acme.setup import register as register_acme_hooks
    register_acme_hooks()
```

Entry-point resolution happens once per process (lazy, on first
`registry.build` / `specs()` call). Per-plugin failures are logged and
swallowed — one broken third-party plugin will not brick the TUI.

---

## 10. Testing checklist

The bare minimum for a new provider:

| File | What it covers |
| --- | --- |
| `tests/unit/test_<type>_provider.py` | Round-trip: instantiate via factory, exercise `list_changes_since` / `get_item` / `transition` against an SDK fake, assert canonical types come out. |
| `tests/unit/test_state_map_reverse.py` | Add cases under your `type_id` so the round-trip guard runs against your map. |
| `tests/unit/test_provider_setup_hooks.py` | Add the type id to whichever fixture lists "specs that must have hooks". |
| `tests/integration/test_setup_wizard.py` | End-to-end CLI wizard run: pick the new provider, exercise discovery + default-view picker, assert config writes. |
| `tests/integration/test_api_setup.py` | (Optional) `/setup/providers/{type_id}/discover` round-trip with the new provider's axes shape — proves the SPA's wire format works. |

Architectural guards that should keep passing without changes:
- `tests/unit/test_import_boundary.py` — fails if you accidentally import
  your concrete provider from `core/`, `agent/`, `api/`, or `storage/`.
- `tests/unit/test_tool_registration_order.py` — fails if your provider
  somehow shifted the agent's tool registration order.

When in doubt, copy a sibling test and rename. `test_github_provider.py`
+ `test_github_stub_provider.py` cover most shapes; ADO's
`test_azure_devops_mapping.py` + the `pytest-recording` cassettes under
`tests/integration/test_azure_devops_provider.py` are the reference for
SDK-shaped fakes.

---

## 11. End-to-end verification

Once everything's wired:

```bash
make check                          # ruff + mypy + bun typecheck/lint + pytest, both trees
make clean-workspace                # nuke ./.docket-dev so the next setup is fresh
make serve WORKSPACE=./.docket-dev  # boots backend + SPA watcher + bootstrap mode
```

Then walk through the wizard end-to-end (browser at http://127.0.0.1:8765/):

1. CLI step picks up your provider's `requires_cli` probe.
2. Provider step lists your `setup_fields` from
   `/setup/providers/types`.
3. Connection step calls your `discover_step` for every datalist.
4. Default-view step renders one chip group per `scope_axes` entry plus
   the always-on assignee + state-bucket chips. Selections become the
   provider entry's `views.default`.
5. Review step's chips iterate `scope_axes` generically — each axis
   value should appear with the spec's label, not a hardcoded one.
6. Finish setup → restart → `docket list --provider <key>` shows the items.
7. `docket transition <id> start_work --dry-run` exercises the proposal +
   state-map round-trip.

If any step shows an ADO field name where you expected your axis label,
that's a missed leak — file it and re-read the relevant phase doc in
[`PROVIDER_INDEPENDENCE_PLAN.md`](PROVIDER_INDEPENDENCE_PLAN.md).

---

## Reference

- `src/docket/providers/base.py` — `WorkItemProvider`, `ProviderSpec`,
  `ScopeAxis`, `SetupField`, `LabelTemplate`, `GroupingStrategy`,
  `AxisMatcher`, `AxisExtractor`.
- `src/docket/providers/registry.py` — `register`, `build`, `specs`,
  `spec`, `normalize_config`, `load_entry_points`.
- `src/docket/config/setup_hooks.py` — `WizardHooks`, `WizardStep`,
  `DiscoverFn`, `DiscoveryItem`.
- `src/docket/core/model.py` — `Item`, `ItemKind`, `ItemState`,
  `TransitionIntent`, `SavedView`, `ScopeFilters`, `CreateFields`.
- `src/docket/core/services/visual_filter.py` — view-time filter +
  facet computation.
- `tests/fakes/provider.py` — `FakeProvider` reference impl.
