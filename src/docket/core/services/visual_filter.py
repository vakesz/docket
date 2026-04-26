"""Post-cache scope filtering.

`ScopeFilters` used to be a sync-time provider query filter; now it's purely
a view-time filter over the cached `items` table. This module resolves the
filter against a provider and applies it to lists coming out of the cache.

Two axes are handled here:

- `assignee` — special, because it has the `@me` sentinel that resolves to
  the provider's `current_user_identity`. Providers that can't report their
  identity degrade `@me` to "no filter" rather than hiding everything.
- `axes` — a free-form mapping declared by `ProviderSpec.scope_axes`. The
  spec also provides an `axis_matcher` callback that this module invokes
  per (item, axis_key, value) so `core/` stays provider-agnostic.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field

from docket.core.model import Item, ScopeFilters
from docket.providers.base import AxisMatcher, ProviderSpec, WorkItemProvider

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResolvedFilter:
    """Concrete values ready to be handed to the storage layer.

    `assignee` is an exact match against `Item.assignee` when non-empty.
    `None`/empty means the assignee axis should not narrow the result.
    `axes` carries only the constrained provider-defined axes (empty
    strings dropped); `matcher` is the provider's view-time predicate."""

    assignee: str | None = None
    axes: Mapping[str, str] = field(default_factory=dict)
    matcher: AxisMatcher | None = None

    @property
    def is_active(self) -> bool:
        return bool(self.assignee or self.axes)


def resolve(
    filters: ScopeFilters,
    provider: WorkItemProvider | None,
    spec: ProviderSpec | None = None,
) -> ResolvedFilter:
    """Translate a `ScopeFilters` into concrete match values.

    `@me` is resolved by asking the provider for its authenticated-user
    identity. Providers that don't implement `current_user_identity` (or
    return None) make the assignee axis a no-op — safer than hiding every
    row when we can't say for sure who the user is.

    `axes` carries through the constrained provider-defined values; the
    spec's matcher is captured so callers can apply it without re-looking
    up the registry. When `spec` is omitted (legacy fakes / tests) the
    axes still pass through but won't narrow anything since there's no
    matcher to invoke."""
    assignee: str | None = None
    if filters.assignee and filters.assignee != "@me":
        assignee = filters.assignee
    elif filters.assignee == "@me" and provider is not None:
        # Some providers (fakes, stubs) don't implement this — fall through
        # to no filter rather than crashing the list view.
        resolver = getattr(provider, "current_user_identity", None)
        if callable(resolver):
            try:
                resolved = resolver()
            except Exception:
                # Provider plugins are arbitrary code; we can't enumerate
                # the failure modes. Log so this isn't a silent fallback.
                log.exception(
                    "provider %s failed to resolve current_user_identity",
                    type(provider).__name__,
                )
                resolved = None
            if isinstance(resolved, str) and resolved:
                assignee = resolved
    axes = {k: v for k, v in filters.axes.items() if v}
    matcher = spec.axis_matcher if spec is not None else None
    return ResolvedFilter(assignee=assignee, axes=axes, matcher=matcher)


def apply_to_items(items: list[Item], resolved: ResolvedFilter) -> list[Item]:
    """Filter a list of cached items in-memory using the resolved filter.

    `assignee` is handled at the SQL layer when possible; this function
    still applies it as a belt-and-suspenders check so callers that hit the
    list via iteration (not `list_items`) get the same shape. Provider-
    defined axes route through the spec's matcher — when no matcher is
    registered (third-party provider that opted out of view-time filtering,
    or a test fake), the axes are skipped silently rather than mistakenly
    hiding rows."""
    if not resolved.is_active:
        return items
    matcher = resolved.matcher
    out: list[Item] = []
    for it in items:
        if resolved.assignee and it.assignee != resolved.assignee:
            continue
        if (
            resolved.axes
            and matcher is not None
            and not all(matcher(it, key, value) for key, value in resolved.axes.items())
        ):
            continue
        out.append(it)
    return out


__all__ = ["ResolvedFilter", "apply_to_items", "resolve"]
