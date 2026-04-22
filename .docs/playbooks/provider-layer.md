# Provider Layer

- Implement `WorkItemProvider` completely and translate into canonical types at the boundary.
- Keep native state strings and field quirks inside provider packages.
- Register providers through `providers/registry.py`, not ad hoc imports from surface code.
- Optional capabilities should be exposed by method presence, not by bloating the base protocol.
- Start from the stub provider when adding a new backend.
- Related docs: [Architecture](../architecture.md), [Modules](../modules.md), [Config and Setup](config-and-setup.md)

## Architecture Overview

```text
surface/service
     |
     v
providers.base.WorkItemProvider
     |
     +--> providers/azure_devops/*
     +--> providers/github/*
     +--> providers/github_stub/*
     |
     v
canonical Item / Comment / PRMatch / TransitionIntent
```

## Ownership Boundaries

- `src/docket/providers/base.py` owns the protocol and shared provider errors.
- `src/docket/providers/registry.py` owns provider factories and entry-point discovery.
- Each provider package owns native auth, discovery, field mapping, and state mapping.
- `src/docket/core/model.py` owns canonical enums and data types; providers map into them.

## Core Rules

- Return canonical `ItemState` and `ItemKind` from every provider call; raw native details belong in `item.provider_raw` (`src/docket/providers/base.py`, `src/docket/core/model.py`).
- Keep transition mapping inside `state_map.py` and cover every `TransitionIntent` (`src/docket/providers/azure_devops/state_map.py`, `src/docket/providers/github/state_map.py`, `tests/test_state_map_reverse.py`).
- Raise shared provider errors so CLI, TUI, and API surfaces can present failures uniformly (`src/docket/providers/base.py`, `src/docket/providers/github/provider.py`, `src/docket/providers/azure_devops/provider.py`).
- Register third-party providers through the `docket.providers` entry-point group and the registry loader (`src/docket/providers/registry.py`).
- Gate optional tools like `find_related_prs` by checking whether the provider actually exposes the method (`src/docket/agent/tool_defs.py`).

## Code Pattern

```python
def transition(self, id: str, intent: TransitionIntent) -> Item:
    current = self.get_item(id)
    native_state, native_reason = to_native(intent)
    updated = Item(
        id=current.id,
        kind=current.kind,
        title=current.title,
        description_md=current.description_md,
        state=to_canonical(native_state, native_reason),
        assignee=current.assignee,
        parent_id=current.parent_id,
        tags=list(current.tags),
        updated_at=datetime.now(UTC),
        url=current.url,
        provider_raw={
            **current.provider_raw,
            "github_state": native_state,
            "github_state_reason": native_reason,
        },
    )
```

Derived from `src/docket/providers/github_stub/provider.py`.

## Non-Obvious Patterns

- Providers that cannot honor a scope filter should return a superset, not silently exclude rows; storage or callers can narrow further.
- GitHub and the stub share state-map logic today; that is inside the provider layer and does not leak into canonical code.
- The current interactive setup wizard is a boundary exception because it imports concrete providers directly; treat that as legacy, not a model to copy.

## Common Scenarios

### Add a provider

- Copy the structure of `src/docket/providers/github_stub/`.
- Add a factory in `src/docket/providers/registry.py` or via package entry point.
- Add provider-specific tests, then run the cross-provider suite.

### Add a new transition intent

- Extend `TransitionIntent` in `src/docket/core/model.py`.
- Update every provider state map.
- Run the round-trip tests before touching any surface code.

## Validation Checklist

- [ ] `uv run pytest tests/test_github_stub_provider.py`
- [ ] `uv run pytest tests/test_state_map_reverse.py tests/test_import_boundary.py`
- [ ] Run provider-specific tests such as `tests/test_ado_provider.py` or `tests/test_github_provider.py` when touching a concrete backend
