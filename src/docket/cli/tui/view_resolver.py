"""Pure helpers that turn `TuiContext` + config into rendering parameters.

These live outside `DocketApp` because they're pure — given a `TuiContext`
they just read a few fields and return a value, no Textual coupling and no
side effects. Pulling them out keeps `app.py` focused on event handlers and
widget wiring, and lets unit tests exercise the resolution logic without
spinning up a pilot app.

The naming here is intentional: `resolve_*` functions each answer one
specific rendering question (the list-items tree's stale threshold, the
sync interval to pass to the watcher, etc). Callers in `app.py` are thin
one-line delegates so the `DocketApp` internal vocabulary (`_resolved_*`,
`_active_*`) stays unchanged."""

from __future__ import annotations

from typing import TYPE_CHECKING

from docket.core.model import ItemState, project_id_for
from docket.core.services import visual_filter
from docket.providers import registry

if TYPE_CHECKING:
    from docket.cli.tui.app import TuiContext
    from docket.config.models import ProviderEntry
    from docket.providers.base import GroupingStrategy


def provider_display_key(ctx: TuiContext) -> str:
    """Key into per-provider override dicts (stale threshold, sync floor).

    Intentionally distinct from `ctx.provider_key` (the config id) — the
    settings surfaces keyed these dicts by the provider's human display
    name before multi-provider was a thing, so we have to honor that."""
    prov = ctx.provider
    name = getattr(prov, "display_name", None) or type(prov).__name__
    return str(name)


def resolve_stale_threshold(ctx: TuiContext) -> int | None:
    """Global default, unless the active provider has its own override.

    Returns `None` when the marker is disabled so `ItemTree` can short-circuit
    instead of checking `> 0` every render."""
    per_provider = ctx.stale_threshold_by_provider or {}
    value = per_provider.get(provider_display_key(ctx), ctx.stale_threshold_days)
    return value if value and value > 0 else None


def resolve_sync_interval(ctx: TuiContext) -> float:
    """Configured interval, clamped up to the per-provider floor (if any).

    `0` means disabled — and stays disabled even with a floor set, because
    the floor only protects an already-enabled timer from exceeding the
    provider's rate limit."""
    base = ctx.background_sync_interval_seconds
    if base <= 0:
        return 0.0
    floors = ctx.background_sync_min_interval_by_provider or {}
    floor = floors.get(provider_display_key(ctx), 0.0)
    return max(base, floor)


def resolve_grouping(ctx: TuiContext) -> GroupingStrategy:
    """Grouping strategy declared by the active provider's spec.

    Falls back to `"by_kind"` when the config isn't available (pilot tests)
    or the provider's type id isn't registered."""
    entry = active_provider_entry(ctx)
    if entry is None:
        return "by_kind"
    spec = registry.spec(entry.type)
    if spec is None:
        return "by_kind"
    return spec.grouping


def resolve_list_item_states(ctx: TuiContext) -> tuple[ItemState, ...] | None:
    """States to pass to `item_repo.list_items`. `None` means "no filter"
    — for the "show done" toggle — and matches calling `list_items` with no
    `states=` argument."""
    if not ctx.hide_done:
        return None
    return (
        ItemState.NEW,
        ItemState.ACTIVE,
        ItemState.BLOCKED,
        ItemState.NEEDS_INFO,
    )


def active_view_filter(ctx: TuiContext) -> visual_filter.ResolvedFilter:
    """Resolve the active saved view into a post-cache filter.

    `@me` is asked of the active provider; scopes without a first-class SQL
    column (area/iteration/team) are applied in Python by
    `visual_filter.apply_to_items`."""
    return visual_filter.resolve(ctx.scope, ctx.provider)


def active_provider_entry(ctx: TuiContext) -> ProviderEntry | None:
    """Resolve the `ProviderEntry` behind the currently-active provider.

    Returns `None` when the TUI was mounted without a full `config` (pilot
    tests), which lets callers short-circuit safely."""
    config = ctx.config
    if config is None:
        return None
    key = ctx.provider_key
    return config.providers.get(key) if key else None


def resolve_project_name(ctx: TuiContext) -> str:
    """Display name for the active project (= active provider), or empty
    string when the TUI was mounted without a project table (pilot tests)."""
    cfg = ctx.config
    if cfg is None:
        return ""
    pid = project_id_for(ctx.provider_key)
    entry = cfg.projects.get(pid)
    return entry.name if entry else ""


__all__ = [
    "active_provider_entry",
    "active_view_filter",
    "provider_display_key",
    "resolve_grouping",
    "resolve_list_item_states",
    "resolve_project_name",
    "resolve_stale_threshold",
    "resolve_sync_interval",
]
