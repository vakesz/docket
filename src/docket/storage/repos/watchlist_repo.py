"""Watchlist repo — pins survive scope/view switches.

The TUI renders a "Pinned" section at the top of the item tree that is
always populated from this table, regardless of which saved view is
active. `pin` / `unpin` are idempotent so keystrokes that race with a
background sync don't raise.

`list_pinned_items` does the join to `items`; missing ids are silently
excluded (see `storage/schema.py` for why we don't FK)."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from docket.core.model import Item
from docket.storage.item_keys import item_storage_key, item_storage_prefix, split_item_storage_key
from docket.storage.repos.item_repo import _row_to_item


def pin(
    conn: sqlite3.Connection,
    item_id: str,
    *,
    provider_key: str = "",
    at: datetime | None = None,
) -> None:
    """Pin an item. Idempotent — re-pinning refreshes `pinned_at`."""
    when = (at or datetime.now(UTC)).isoformat()
    conn.execute(
        """
        INSERT INTO watchlist (id, pinned_at) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET pinned_at = excluded.pinned_at
        """,
        (item_storage_key(provider_key, item_id), when),
    )


def unpin(conn: sqlite3.Connection, item_id: str, *, provider_key: str = "") -> None:
    """Unpin an item. No-op if it wasn't pinned."""
    conn.execute("DELETE FROM watchlist WHERE id = ?", (item_storage_key(provider_key, item_id),))


def is_pinned(conn: sqlite3.Connection, item_id: str, *, provider_key: str = "") -> bool:
    row = conn.execute(
        "SELECT 1 FROM watchlist WHERE id = ?",
        (item_storage_key(provider_key, item_id),),
    ).fetchone()
    return row is not None


def list_pinned_ids(conn: sqlite3.Connection, *, provider_key: str | None = None) -> list[str]:
    """Return pinned ids newest-first. Cheap — used on every tree reload."""
    if provider_key:
        cursor = conn.execute(
            "SELECT id FROM watchlist WHERE id LIKE ? ORDER BY pinned_at DESC",
            (f"{item_storage_prefix(provider_key)}%",),
        )
    else:
        cursor = conn.execute("SELECT id FROM watchlist ORDER BY pinned_at DESC")
    return [split_item_storage_key(row[0])[1] for row in cursor.fetchall()]


def list_pinned_items(conn: sqlite3.Connection, *, provider_key: str | None = None) -> list[Item]:
    """Return the pinned items that still exist in the cache, newest-first.

    Join on `items.id` so deleted or archived-out rows don't appear; they
    can reappear after the next sync without any bookkeeping here."""
    if provider_key:
        cursor = conn.execute(
            """
            SELECT i.*
              FROM watchlist w
              JOIN items i ON i.id = w.id
             WHERE i.archived = 0 AND i.provider_key = ?
             ORDER BY w.pinned_at DESC
            """,
            (provider_key,),
        )
    else:
        cursor = conn.execute(
            """
            SELECT i.*
              FROM watchlist w
              JOIN items i ON i.id = w.id
             WHERE i.archived = 0
             ORDER BY w.pinned_at DESC
            """
        )
    return [_row_to_item(row) for row in cursor.fetchall()]


__all__ = ["is_pinned", "list_pinned_ids", "list_pinned_items", "pin", "unpin"]
