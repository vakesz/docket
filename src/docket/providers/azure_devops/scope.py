"""Per-axis view-time matcher for Azure DevOps cached items.

The visual filter calls this once per `(item, axis_key, value)` tuple while
narrowing the cached list. We look only at `Item.provider_raw["fields"]` —
the raw WIQL response — so this stays a pure function over the cache.

Axes mirror the columns ADO surfaces in `_DEFAULT_FIELDS` (see
`provider.py`):
- `area_path` / `iteration_path` behave like WIQL's `UNDER` operator: a
  stored path of `A\\B\\C` matches a filter of `A` or `A\\B`.
- `team` is not a first-class WIQL clause; we approximate by checking
  `System.NodeName` and `System.TeamProject`. Items missing the field
  fall through to "no match" rather than silently passing.
"""

from __future__ import annotations

from docket.core.model import Item


def axis_matcher(item: Item, axis_key: str, expected: str) -> bool:
    """Dispatch to the per-axis matcher. Unknown axes return False so a
    misconfigured filter narrows to nothing rather than silently widening."""
    if axis_key == "area_path":
        return _matches_path(item, "System.AreaPath", expected)
    if axis_key == "iteration_path":
        return _matches_path(item, "System.IterationPath", expected)
    if axis_key == "team":
        return _matches_team(item, expected)
    return False


def _matches_path(item: Item, field: str, expected: str) -> bool:
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    value = raw.get(field)
    if not isinstance(value, str):
        return False
    return value == expected or value.startswith(expected + "\\")


def _matches_team(item: Item, expected: str) -> bool:
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    node_name = raw.get("System.NodeName")
    if isinstance(node_name, str) and node_name == expected:
        return True
    team_project = raw.get("System.TeamProject")
    return isinstance(team_project, str) and team_project == expected


__all__ = ["axis_matcher"]
