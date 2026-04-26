"""Per-axis view-time helpers for Azure DevOps cached items.

Two callbacks live here, both pure functions over `Item.provider_raw`
so `core/` stays provider-agnostic — the registry wires them onto
`ProviderSpec.axis_matcher` / `axis_extract`:

- `axis_matcher(item, axis_key, expected)` — returns True iff the item
  belongs in the narrowed set for that axis value. `area_path` /
  `iteration_path` use UNDER semantics (a stored `A\\B\\C` matches
  filters of `A` or `A\\B`); `team` checks `System.NodeName` /
  `System.TeamProject`.
- `axis_extract(item, axis_key)` — returns the canonical value the item
  carries for that axis, or None if absent. The visual filter calls this
  to populate the chip popovers (top-N values + counts).
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


def axis_extract(item: Item, axis_key: str) -> str | None:
    """Return the canonical value `item` carries for `axis_key`, or None.

    Unknown axes return None so the facet popover shows nothing rather
    than mistakenly populating with the wrong field."""
    raw = item.provider_raw.get("fields") if item.provider_raw else None
    if not isinstance(raw, dict):
        return None
    if axis_key == "area_path":
        value = raw.get("System.AreaPath")
        return value if isinstance(value, str) and value else None
    if axis_key == "iteration_path":
        value = raw.get("System.IterationPath")
        return value if isinstance(value, str) and value else None
    if axis_key == "team":
        # `team` axis matches either NodeName or TeamProject. Prefer the
        # more specific NodeName; fall back to TeamProject. Selection
        # popovers then show actual team values rather than just the
        # project root.
        node = raw.get("System.NodeName")
        if isinstance(node, str) and node:
            return node
        team = raw.get("System.TeamProject")
        return team if isinstance(team, str) and team else None
    return None


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


__all__ = ["axis_extract", "axis_matcher"]
