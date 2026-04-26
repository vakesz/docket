"""Single source of truth for the open/done/all state-bucket grouping.

Used by the visual-filter layer to apply the `state` facet, by the TUI's
ItemTree styling, and exposed over `/api/items` so the SPA can render the
same buckets without redefining them. Keep this canonical — earlier the
tree (Python) and the SPA (TS) each had their own copy of the lists, and
they drifted.

`open` and `closed` are the two real buckets. `all` is a synthetic value
the chip uses to mean "no narrowing"; it's not a third partition."""

from __future__ import annotations

from typing import Literal, get_args

from docket.core.model import ItemState

StateBucket = Literal["open", "closed", "all"]
"""Selectable values for the `state` facet."""

STATE_BUCKETS: tuple[StateBucket, ...] = get_args(StateBucket)


OPEN_STATES: frozenset[ItemState] = frozenset(
    {ItemState.NEW, ItemState.ACTIVE, ItemState.BLOCKED, ItemState.NEEDS_INFO}
)
"""States that count as 'open' for the open/closed bucket facet."""

DONE_STATES: frozenset[ItemState] = frozenset({ItemState.RESOLVED, ItemState.CLOSED})
"""States that count as 'closed/done' for the open/closed bucket facet."""


def matches_bucket(state: ItemState, bucket: StateBucket) -> bool:
    """True iff `state` belongs in `bucket`. `'all'` always matches."""
    if bucket == "all":
        return True
    if bucket == "open":
        return state in OPEN_STATES
    return state in DONE_STATES


__all__ = [
    "DONE_STATES",
    "OPEN_STATES",
    "STATE_BUCKETS",
    "StateBucket",
    "matches_bucket",
]
