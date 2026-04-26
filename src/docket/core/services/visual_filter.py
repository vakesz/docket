"""Post-cache view filtering and facet computation.

Sync pulls the full project; everything that narrows the user's view
happens here. `ScopeFilters` is no longer a sync-time provider query — it's
the merged set of "saved view defaults + session chip-bar overrides" that
the surface layer hands in.

This module owns three responsibilities:

- `resolve(filters, provider, spec)` — translate a `ScopeFilters` into a
  concrete `ResolvedFilter`. `@me` becomes the provider's
  `current_user_identity()`; providers that can't report identity collapse
  `@me` to "no narrowing" rather than hiding everything.
- `apply_to_items(items, resolved)` — narrow a list to items that match
  every active facet. Multi-select within a facet is OR; across facets AND.
- `compute_facets(items, spec, project_view)` — compute top-N values + counts
  per facet for the chip popovers, off the *unfiltered* cache so chips don't
  vanish when the user picks one. The provider-agnostic invariant holds: this
  module never reaches into `Item.provider_raw` directly. State buckets and
  assignees come off canonical `Item` fields; provider-defined axes route
  through `ProviderSpec.axis_extract`.
"""

from __future__ import annotations

import logging
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from docket.core.model import Item, ScopeFilters
from docket.core.state_buckets import StateBucket, matches_bucket
from docket.providers.base import AxisExtractor, AxisMatcher, ProviderSpec, WorkItemProvider

log = logging.getLogger(__name__)

# Reserved facet ids that every provider exposes regardless of scope axes.
RESERVED_FACETS: tuple[str, ...] = ("assignee", "state", "tags")


@dataclass(frozen=True)
class ResolvedFilter:
    """Concrete values ready to be applied to a cached item list.

    `assignees` is the OR-set of identities the user wants to see. `@me`
    has already been resolved against the provider; the empty tuple means
    no assignee narrowing. `axes` carries only the constrained provider-
    defined axes (empty value tuples dropped). `state_bucket` is one of
    `"open" | "closed" | "all"`. `matcher` is the provider's per-axis
    predicate, captured here so callers don't re-look-up the registry."""

    assignees: tuple[str, ...] = ()
    axes: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    state_bucket: StateBucket = "open"
    matcher: AxisMatcher | None = None

    @property
    def is_active(self) -> bool:
        """True when at least one facet is constrained beyond defaults."""
        return bool(self.assignees or self.axes) or self.state_bucket != "all"


@dataclass(frozen=True)
class FacetOption:
    """One value inside a chip popover's top-N list."""

    value: str
    count: int


@dataclass(frozen=True)
class Facet:
    """A single chip on the view bar.

    `key` is the facet id (`"assignee"`, `"state"`, `"tags"`, or a provider-
    defined axis key). `label` is the human-readable chip label. `options`
    is the (already-capped) top-N list of values. `total_options` is the
    full count before capping so the SPA can render "+N more"."""

    key: str
    label: str
    options: tuple[FacetOption, ...]
    total_options: int


def resolve(
    filters: ScopeFilters,
    provider: WorkItemProvider | None,
    spec: ProviderSpec | None = None,
) -> ResolvedFilter:
    """Translate a `ScopeFilters` into concrete match values.

    `@me` is resolved by asking the provider for its authenticated-user
    identity; the literal `@me` is replaced with the resolved string and
    de-duplicated against the rest of the assignee selection. Providers
    that don't implement `current_user_identity` (or return None) drop
    the `@me` token rather than hiding everything — safer than collapsing
    the entire view when we can't say for sure who the user is."""
    assignees = _resolve_assignees(filters.assignees, provider)
    axes = {k: tuple(v) for k, v in filters.axes.items() if v}
    matcher = spec.axis_matcher if spec is not None else None
    return ResolvedFilter(
        assignees=assignees,
        axes=axes,
        state_bucket=filters.state_bucket,
        matcher=matcher,
    )


def apply_to_items(items: list[Item], resolved: ResolvedFilter) -> list[Item]:
    """Narrow `items` to those that match every active facet.

    Multi-select within a single facet is OR (a story tagged either
    "frontend" or "backend" passes a `tags ∈ {frontend, backend}` chip).
    Across facets it's AND (a story must match every constrained chip).
    `state_bucket` always applies; `assignees` and `axes` only narrow when
    the user has selected at least one value."""
    matcher = resolved.matcher
    out: list[Item] = []
    for it in items:
        if not matches_bucket(it.state, resolved.state_bucket):
            continue
        if resolved.assignees and (it.assignee or "") not in resolved.assignees:
            continue
        if resolved.axes:
            if matcher is None:
                # Provider didn't register a matcher; skip axis narrowing
                # rather than hiding everything — the chip never should have
                # been offered, but tolerate misconfiguration gracefully.
                pass
            elif not all(
                any(matcher(it, key, v) for v in values)
                for key, values in resolved.axes.items()
            ):
                continue
        out.append(it)
    return out


def compute_facets(
    items: list[Item],
    *,
    spec: ProviderSpec | None,
    project_view: ProjectViewLike,
) -> list[Facet]:
    """Build the chip-bar facets off the unfiltered item list.

    Computing off the unfiltered list keeps chips stable: picking one tag
    doesn't make the other tags disappear from the popover. The caller
    (TUI / API) decides how to present the result — this layer just
    enumerates per-facet (value, count) pairs capped to
    `project_view.for_facet(key).max_options`.

    `spec` may be None for fakes / tests with no registered axes; in that
    case only the reserved facets render."""
    facets: list[Facet] = []
    for key in RESERVED_FACETS:
        cfg = project_view.for_facet(key)
        if not cfg.visible:
            continue
        counts = _count_reserved(items, key)
        facets.append(_build_facet(key, _label_for_reserved(key), counts, cfg.max_options))
    if spec is not None and spec.scope_axes:
        extractor = spec.axis_extract
        for axis in spec.scope_axes:
            cfg = project_view.for_facet(axis.key)
            if not cfg.visible:
                continue
            counts = _count_axis(items, axis.key, extractor)
            facets.append(_build_facet(axis.key, axis.label, counts, cfg.max_options))
    return facets


# -- internal helpers ----------------------------------------------------


def _resolve_assignees(
    assignees: tuple[str, ...],
    provider: WorkItemProvider | None,
) -> tuple[str, ...]:
    """Expand `@me` to the provider's identity (or drop it if unknown)."""
    if not assignees:
        return ()
    resolved: list[str] = []
    me: str | None = None
    me_resolved = False
    for value in assignees:
        if value == "@me":
            if not me_resolved:
                me = _provider_identity(provider)
                me_resolved = True
            if me:
                resolved.append(me)
            # else: drop the @me token; can't resolve who "me" is
        elif value:
            resolved.append(value)
    seen: set[str] = set()
    deduped: list[str] = []
    for v in resolved:
        if v not in seen:
            seen.add(v)
            deduped.append(v)
    return tuple(deduped)


def _provider_identity(provider: WorkItemProvider | None) -> str | None:
    if provider is None:
        return None
    resolver = getattr(provider, "current_user_identity", None)
    if not callable(resolver):
        return None
    try:
        value = resolver()
    except Exception:
        log.exception(
            "provider %s failed to resolve current_user_identity",
            type(provider).__name__,
        )
        return None
    return value if isinstance(value, str) and value else None


def _count_reserved(items: list[Item], key: str) -> Counter[str]:
    counts: Counter[str] = Counter()
    if key == "assignee":
        for it in items:
            if it.assignee:
                counts[it.assignee] += 1
    elif key == "state":
        for it in items:
            counts[it.state.value] += 1
    elif key == "tags":
        for it in items:
            for tag in it.tags:
                if tag:
                    counts[tag] += 1
    return counts


def _count_axis(
    items: list[Item],
    axis_key: str,
    extractor: AxisExtractor | None,
) -> Counter[str]:
    counts: Counter[str] = Counter()
    if extractor is None:
        return counts
    for it in items:
        try:
            value = extractor(it, axis_key)
        except Exception:
            log.exception("axis_extract(%s) failed", axis_key)
            continue
        if isinstance(value, str) and value:
            counts[value] += 1
    return counts


def _build_facet(
    key: str,
    label: str,
    counts: Counter[str],
    cap: int,
) -> Facet:
    total = len(counts)
    top = counts.most_common(cap) if cap > 0 else []
    options = tuple(FacetOption(value=v, count=c) for v, c in top)
    return Facet(key=key, label=label, options=options, total_options=total)


def _label_for_reserved(key: str) -> str:
    if key == "assignee":
        return "Assignee"
    if key == "state":
        return "State"
    if key == "tags":
        return "Tags"
    return key


@runtime_checkable
class FacetConfigLike(Protocol):
    """Duck-typed view of `docket.config.models.FacetConfig`."""

    visible: bool
    max_options: int


@runtime_checkable
class ProjectViewLike(Protocol):
    """Structural alias for `ProjectViewConfig.for_facet` so `core/services/`
    doesn't need to import `docket.config.models`."""

    def for_facet(self, key: str) -> FacetConfigLike: ...


__all__ = [
    "RESERVED_FACETS",
    "Facet",
    "FacetOption",
    "ResolvedFilter",
    "apply_to_items",
    "compute_facets",
    "resolve",
]
