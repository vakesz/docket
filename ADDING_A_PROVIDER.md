# Adding a provider

This walks through adding a new work-item backend (Jira, GitHub Issues, Linear, etc.) to Docket. The stable contract is the `WorkItemProvider` Protocol in `src/docket/providers/base.py`. Everything above that layer — sync, mutations, the agent, the TUI, the HTTP API — is provider-agnostic and keeps working unchanged once the new provider satisfies the Protocol.

The `src/docket/providers/github_stub/` module is a fully-working, in-memory reference implementation. Read it first; it's ~150 lines and covers every method you need. `src/docket/providers/azure_devops/` is the production-grade example with real network I/O, auth, and field discovery.

## 1. What a provider is (and isn't)

A provider is the *only* place allowed to know about a backend's wire format. Its job is to:

1. Fetch items, comments, links, and change streams.
2. Translate native state strings into canonical `ItemState` values **before** handing an `Item` up.
3. Translate canonical `TransitionIntent` values into native write operations.
4. Report its health on demand.

A provider is **not** allowed to:

- Leak provider-specific state strings through `Item.state`. Put native state in `Item.provider_raw` if the agent or UI needs to see it, but canonical state must be canonical.
- Decide triage policy. "Is this ticket stale?" and "should we close this?" live in service and agent code.
- Persist anything. The cache, watermarks, and transcripts are core concerns — the provider is stateless between calls.

## 2. The contract

```python
@runtime_checkable
class WorkItemProvider(Protocol):
    def health_check(self) -> None: ...
    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]: ...
    def get_item(self, id: str) -> Item: ...
    def get_comments(self, id: str) -> list[Comment]: ...
    def get_linked(self, id: str) -> list[Item]: ...
    def transition(self, id: str, intent: TransitionIntent) -> Item: ...
    def patch_description(self, id: str, new_md: str) -> Item: ...
    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str: ...
    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item: ...
```

Notes on individual methods:

- **`health_check`** — raise `ProviderUnreachableError` / `ProviderAuthError` from `providers/base.py`. Return `None` on success. Per plan §13, the caller fails fast; don't swallow.
- **`list_changes_since`** — watermark is the newest `updated_at` the cache has seen for this scope. Return items strictly newer than the watermark. Returning everything when watermark is `None` is correct (that's a full refresh).
- **`transition`** — input is a `TransitionIntent`, not a native state. The *provider* decides how to realize it. If an intent has no clean native equivalent, pick the closest legal one and encode the nuance in `provider_raw` (see `github_stub/state_map.py` for how `BLOCK`/`NEEDS_INFO` fall back to `open` with no reason).
- **`upload_attachment`** — return a URL. If the backend doesn't support direct uploads (e.g. GitHub), the convention is to post a comment with a pre-signed URL and return that.
- **`create_item`** — return an `Item` with `state=ItemState.NEW` or `ItemState.ACTIVE` depending on what the backend opens tickets in. Don't second-guess; whatever the backend actually did is what goes back.

Errors that core knows how to handle live in `providers/base.py`: `ProviderError`, `ProviderUnreachableError`, `ProviderAuthError`. Raise those instead of backend-specific exceptions so the CLI / TUI / API can render them uniformly.

## 3. The state translation pattern

Every provider needs two lookup tables and two tiny helpers. Copy the shape from `github_stub/state_map.py`:

```python
# backend-native state → canonical ItemState
NATIVE_TO_CANONICAL: dict[KeyT, ItemState] = { ... }

# TransitionIntent → backend-native write
INTENT_TO_NATIVE: dict[TransitionIntent, NativeT] = { ... }

def to_canonical(...) -> ItemState: ...
def to_native(intent: TransitionIntent) -> NativeT: ...
```

Two rules:

1. **`to_canonical` must total.** If the backend ships a new state string tomorrow, you cannot raise — pick a safe fallback. GitHub's stub collapses unknown `closed` reasons to `CLOSED` and unknown `open` reasons to `ACTIVE`.
2. **`to_native` covers every `TransitionIntent`.** Keep this a plain dict, not a branch tree — `tests/test_state_map_reverse.py`-style tests can iterate the enum and assert coverage.

`ItemKind` gets the same treatment when the backend has a fixed vocabulary (see `azure_devops/state_map.py`'s `KIND_BY_WIT` / `WIT_BY_KIND`). Backends without a kind taxonomy (GitHub Issues, Linear) can just record the canonical kind in a label or in `provider_raw`.

## 4. Canonical model quirks worth knowing

- `Item.id` is opaque to core. Use whatever identifier round-trips cleanly: `{owner}/{repo}#{number}` for GitHub, the integer work-item id for ADO, `ABC-123` for Jira. Keep it stable across syncs — the cache is keyed by it.
- `Item.updated_at` must be timezone-aware. SQLite silently drops tz on read; the external-update watcher (`core/services/external_update_service.py`) coerces naive values to UTC so be consistent.
- `Item.provider_raw` is where you stash anything the agent might need to see but core shouldn't care about: native state, field versions, internal ids for back-refs, etc. It's JSON-serialized, so keep values primitive.
- `parent_id` is the canonical link for hierarchy (epic → feature → story → task/bug). If the backend doesn't have a first-class parent field (GitHub), return `None` and rely on `get_linked` instead — `get_linked` is allowed to return an empty list.

## 5. Wiring a new provider in

Minimum viable checklist for a new provider named `foo`:

1. **Create** `src/docket/providers/foo/` with `__init__.py`, `provider.py`, `state_map.py`. Re-export `FooProvider` from `__init__.py`.
2. **Implement** every Protocol method in `provider.py`. Start with a stub backend (like `github_stub`) so you can run the tests before touching the network layer.
3. **Register** the provider in the config / setup wizard (`src/docket/config/` and `src/docket/cli/setup/`). ADO is the current default — look at how it's selected and follow the same shape.
4. **Add auth** in `providers/foo/auth.py` if the backend needs tokens. Raise `ProviderAuthError` on failures so the wizard can re-prompt.
5. **Run the shared suite** — see §6.

## 6. Tests you get for free

Every provider should satisfy the same cross-cutting tests that live in `tests/test_github_stub_provider.py`. Copy that file, rename the provider, and the following still apply verbatim:

- `test_<name>_satisfies_protocol` — `isinstance(provider, WorkItemProvider)`. This is a structural check; it fails loudly if you miss a method.
- `test_every_intent_maps_to_legal_native_pair` — iterate `TransitionIntent` and assert every one round-trips through `to_native`.
- `test_canonical_roundtrips_for_known_pairs` — one assertion per row in `NATIVE_TO_CANONICAL` plus a fallback assertion for unknown input.
- `test_sync_service_works_against_<name>` — sync the provider into a real SQLite file and assert items show up in the cache. This is the load-bearing abstraction check; if the service layer needs a change to work with your provider, the abstraction leaked.
- `test_mutation_pipeline_works_against_<name>` — propose a transition, confirm it, assert the cache reflects the new state.

The point of duplicating these tests per provider is that they prove *your* provider satisfies the contract. If a future refactor breaks the contract for one provider but not another, you want a failing test in the provider that broke, not in some shared file.

## 7. Performance notes

- **Sync is bulk.** `item_repo.upsert_items` uses `executemany` — don't call `upsert_item` in a loop from the provider or service layer. `tests/test_sync_perf.py` is a guard against regressions here.
- **`list_changes_since` should paginate internally** and yield items incrementally. The service layer materializes them once at the top of `sync_service.refresh`; yielding lets you cap peak memory on full refreshes.
- **`provider_raw` is serialized on every upsert.** Keep it small. If you find yourself stuffing entire REST payloads in there, project them down first.

## 8. Things that are explicitly out of scope for a provider

- Rate-limit retry loops. Do one attempt; let the caller decide what to do with `ProviderUnreachableError`.
- Caching. Core owns the cache.
- Diffing against cached state. That's `external_update_service`'s job.
- Agent-facing policy decisions ("should this trigger a suggestion?"). That lives in `agent/` and `core/services/suggestion_service.py`.

Keeping providers thin is what makes it safe to add Jira next quarter without touching anything else.
