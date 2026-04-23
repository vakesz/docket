"""Post-cache scope filtering.

`ScopeFilters` used to be a sync-time provider query filter; now it's purely
a view-time filter over the cached `items` table. This module resolves the
filter against a provider and applies it to lists coming out of the cache.

`@me` is the important sentinel: the provider knows its own identity
(`current_user_identity`), and we translate the sentinel into a concrete
string match against `items.assignee`. Providers that can't report their
identity degrade `@me` to "no filter" rather than hiding everything.
"""

from __future__ import annotations

from dataclasses import dataclass

from docket.core.model import Item, ScopeFilters
from docket.providers.base import WorkItemProvider


@dataclass(frozen=True)
class ResolvedFilter:
    """Concrete values ready to be handed to the storage layer.

    `assignee` is an exact match against `Item.assignee` when non-empty.
    `None`/empty means the assignee axis should not narrow the result."""

    assignee: str | None = None
    team: str = ""
    area_path: str = ""
    iteration_path: str = ""

    @property
    def is_active(self) -> bool:
        return bool(self.assignee or self.team or self.area_path or self.iteration_path)


def resolve(filters: ScopeFilters, provider: WorkItemProvider | None) -> ResolvedFilter:
    """Translate a `ScopeFilters` into concrete match values.

    `@me` is resolved by asking the provider for its authenticated-user
    identity. Providers that don't implement `current_user_identity` (or
    return None) make the assignee axis a no-op — safer than hiding every
    row when we can't say for sure who the user is."""
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
                resolved = None
            if isinstance(resolved, str) and resolved:
                assignee = resolved
    return ResolvedFilter(
        assignee=assignee,
        team=filters.team,
        area_path=filters.area_path,
        iteration_path=filters.iteration_path,
    )


def apply_to_items(items: list[Item], resolved: ResolvedFilter) -> list[Item]:
    """Filter a list of cached items in-memory using the resolved filter.

    `assignee` is handled at the SQL layer when possible; this function
    still applies it as a belt-and-suspenders check so callers that hit the
    list via iteration (not `list_items`) get the same shape. `team`,
    `area_path`, and `iteration_path` look inside `provider_raw` because
    they don't have first-class columns."""
    if not resolved.is_active:
        return items
    out: list[Item] = []
    for it in items:
        if resolved.assignee and it.assignee != resolved.assignee:
            continue
        if resolved.area_path and not _matches_azure_path(
            it, "System.AreaPath", resolved.area_path
        ):
            continue
        if resolved.iteration_path and not _matches_azure_path(
            it, "System.IterationPath", resolved.iteration_path
        ):
            continue
        if resolved.team and not _matches_azure_team(it, resolved.team):
            continue
        out.append(it)
    return out


def _matches_azure_path(item: Item, field: str, expected: str) -> bool:
    """Azure DevOps area/iteration paths behave like `UNDER` — a row with
    path `A\\B\\C` matches the filter `A` or `A\\B`. Path separators are
    backslashes in the provider payload."""
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    value = raw.get(field)
    if not isinstance(value, str):
        return False
    return value == expected or value.startswith(expected + "\\")


def _matches_azure_team(item: Item, expected: str) -> bool:
    """Team filtering isn't a first-class WIQL clause; it's typically
    expressed via area-path mapping. For now we match against the stored
    `System.NodeName` / `System.TeamProject` if present, and fall through
    to a no-op if the field isn't in provider_raw."""
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    node_name = raw.get("System.NodeName")
    if isinstance(node_name, str) and node_name == expected:
        return True
    team_project = raw.get("System.TeamProject")
    return isinstance(team_project, str) and team_project == expected


__all__ = ["ResolvedFilter", "apply_to_items", "resolve"]
