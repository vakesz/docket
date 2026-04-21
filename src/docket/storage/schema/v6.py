"""v6: watchlist table.

A flat list of item ids the user has pinned. Survives scope/view switches
— the UI joins `watchlist` against `items` on every load to render a
"Pinned" section at the top of the tree regardless of which saved view
is active.

No FK to `items(id)` on purpose: pinning an id that temporarily dropped
out of the cache (e.g., because it's outside the active scope) is a
legitimate state. The join just quietly excludes that row until the next
sync re-adds it.
"""
from __future__ import annotations

STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE watchlist (
        id         TEXT PRIMARY KEY,
        pinned_at  TEXT NOT NULL
    )
    """,
    "CREATE INDEX idx_watchlist_pinned_at ON watchlist(pinned_at DESC)",
)
