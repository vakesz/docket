from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime

from docket.core.model import Comment
from docket.storage.item_keys import item_id_from_storage_key, item_storage_key


def _row_to_comment(row: sqlite3.Row) -> Comment:
    return Comment(
        id=row["id"],
        item_id=item_id_from_storage_key(row["item_id"]),
        author=row["author"],
        body_md=row["body_md"],
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def replace_comments_for_item(
    conn: sqlite3.Connection,
    item_id: str,
    comments: Iterable[Comment],
    *,
    provider_key: str = "",
) -> int:
    storage_id = item_storage_key(provider_key, item_id)
    conn.execute("DELETE FROM comments WHERE item_id = ?", (storage_id,))
    rows = [(c.id, storage_id, c.author, c.body_md, c.created_at.isoformat()) for c in comments]
    if not rows:
        return 0
    conn.executemany(
        "INSERT INTO comments (id, item_id, author, body_md, created_at) VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    return len(rows)


def list_comments(
    conn: sqlite3.Connection, item_id: str, *, provider_key: str | None = None
) -> list[Comment]:
    if provider_key:
        rows = conn.execute(
            "SELECT * FROM comments WHERE item_id = ? ORDER BY created_at ASC",
            (item_storage_key(provider_key, item_id),),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT c.*
            FROM comments c
            JOIN items i ON i.id = c.item_id
            WHERE i.provider_item_id = ?
            ORDER BY c.created_at ASC
            """,
            (item_id,),
        ).fetchall()
    return [_row_to_comment(r) for r in rows]
