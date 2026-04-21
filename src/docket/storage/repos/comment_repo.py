from __future__ import annotations

import sqlite3
from collections.abc import Iterable
from datetime import datetime

from docket.core.model import Comment


def _row_to_comment(row: sqlite3.Row) -> Comment:
    return Comment(
        id=row["id"],
        item_id=row["item_id"],
        author=row["author"],
        body_md=row["body_md"],
        created_at=datetime.fromisoformat(row["created_at"]),
    )


def replace_comments_for_item(
    conn: sqlite3.Connection, item_id: str, comments: Iterable[Comment]
) -> int:
    conn.execute("DELETE FROM comments WHERE item_id = ?", (item_id,))
    n = 0
    for c in comments:
        conn.execute(
            "INSERT INTO comments (id, item_id, author, body_md, created_at) VALUES (?, ?, ?, ?, ?)",
            (c.id, c.item_id, c.author, c.body_md, c.created_at.isoformat()),
        )
        n += 1
    return n


def list_comments(conn: sqlite3.Connection, item_id: str) -> list[Comment]:
    rows = conn.execute(
        "SELECT * FROM comments WHERE item_id = ? ORDER BY created_at ASC",
        (item_id,),
    ).fetchall()
    return [_row_to_comment(r) for r in rows]
