from __future__ import annotations

import sqlite3
from datetime import datetime

from docket.storage._time import now_iso


def get_watermark(conn: sqlite3.Connection, provider_key: str) -> datetime | None:
    row = conn.execute(
        "SELECT watermark_iso FROM sync_state WHERE provider_key = ?", (provider_key,)
    ).fetchone()
    if not row or not row["watermark_iso"]:
        return None
    return datetime.fromisoformat(row["watermark_iso"])


def set_watermark(conn: sqlite3.Connection, provider_key: str, watermark: datetime) -> None:
    conn.execute(
        """
        INSERT INTO sync_state (provider_key, watermark_iso, last_full_sync_at)
        VALUES (?, ?, COALESCE(
            (SELECT last_full_sync_at FROM sync_state WHERE provider_key = ?), ?))
        ON CONFLICT(provider_key) DO UPDATE SET watermark_iso = excluded.watermark_iso
        """,
        (provider_key, watermark.isoformat(), provider_key, now_iso()),
    )


def record_full_sync(conn: sqlite3.Connection, provider_key: str) -> None:
    now = now_iso()
    conn.execute(
        """
        INSERT INTO sync_state (provider_key, watermark_iso, last_full_sync_at)
        VALUES (?, NULL, ?)
        ON CONFLICT(provider_key) DO UPDATE SET last_full_sync_at = excluded.last_full_sync_at
        """,
        (provider_key, now),
    )
