"""Command-palette usage counter.

One row per command id. `record()` bumps `last_used_at` and `usage_count`;
`recent_ids()` returns the N most-recently-used ids in newest-first order so
surfaces can float them to the top of the palette list. No project scope —
commands are app-global and the user's muscle memory is too.
"""

from __future__ import annotations

import sqlite3

from docket.storage._time import now_iso


def record(conn: sqlite3.Connection, command_id: str) -> None:
    """Upsert a usage row for `command_id` at now (UTC)."""
    now = now_iso()
    conn.execute(
        """
        INSERT INTO command_usage (id, last_used_at, usage_count)
        VALUES (?, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
            last_used_at = excluded.last_used_at,
            usage_count  = command_usage.usage_count + 1
        """,
        (command_id, now),
    )


def recent_ids(conn: sqlite3.Connection, *, limit: int = 5) -> list[str]:
    """Return the most-recently-used command ids, newest first.

    `limit` caps how many rows come back. Callers usually want a small N
    (3-7) so the "Recent" section doesn't dominate the palette."""
    rows = conn.execute(
        "SELECT id FROM command_usage ORDER BY last_used_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [row["id"] for row in rows]


def clear(conn: sqlite3.Connection) -> None:
    """Drop all recorded usage. Intended for tests and a future 'forget'
    surface; not currently exposed to users."""
    conn.execute("DELETE FROM command_usage")


__all__ = ["clear", "recent_ids", "record"]
