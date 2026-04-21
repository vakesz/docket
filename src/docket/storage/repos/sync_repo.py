from __future__ import annotations

import sqlite3
from datetime import UTC, datetime


def get_watermark(conn: sqlite3.Connection, scope_key: str) -> datetime | None:
    row = conn.execute(
        "SELECT watermark_iso FROM sync_state WHERE scope_key = ?", (scope_key,)
    ).fetchone()
    if not row or not row["watermark_iso"]:
        return None
    return datetime.fromisoformat(row["watermark_iso"])


def set_watermark(conn: sqlite3.Connection, scope_key: str, watermark: datetime) -> None:
    conn.execute(
        """
        INSERT INTO sync_state (scope_key, watermark_iso, last_full_sync_at)
        VALUES (?, ?, COALESCE(
            (SELECT last_full_sync_at FROM sync_state WHERE scope_key = ?), ?))
        ON CONFLICT(scope_key) DO UPDATE SET watermark_iso = excluded.watermark_iso
        """,
        (scope_key, watermark.isoformat(), scope_key, datetime.now(UTC).isoformat()),
    )


def record_full_sync(conn: sqlite3.Connection, scope_key: str) -> None:
    now = datetime.now(UTC).isoformat()
    conn.execute(
        """
        INSERT INTO sync_state (scope_key, watermark_iso, last_full_sync_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(scope_key) DO UPDATE SET last_full_sync_at = excluded.last_full_sync_at
        """,
        (scope_key, now),
    )
