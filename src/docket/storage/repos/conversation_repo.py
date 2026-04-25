from __future__ import annotations

import sqlite3
from datetime import datetime
from uuid import uuid4

from docket.core.model import Conversation
from docket.storage._time import now_iso, now_utc
from docket.storage.item_keys import item_id_from_storage_key, item_storage_key


def _row_to_conversation(row: sqlite3.Row) -> Conversation:
    return Conversation(
        id=row["id"],
        item_id=item_id_from_storage_key(row["item_id"]),
        started_at=datetime.fromisoformat(row["started_at"]),
        archived_at=datetime.fromisoformat(row["archived_at"]) if row["archived_at"] else None,
        tokens_in=row["tokens_in"],
        tokens_out=row["tokens_out"],
        cost_cents=row["cost_cents"],
    )


def create(conn: sqlite3.Connection, item_id: str, *, provider_key: str = "") -> Conversation:
    convo = Conversation(
        id=str(uuid4()),
        item_id=item_id,
        started_at=now_utc(),
    )
    conn.execute(
        """
        INSERT INTO conversations (id, item_id, started_at, archived_at, tokens_in, tokens_out, cost_cents)
        VALUES (?, ?, ?, NULL, 0, 0, 0)
        """,
        (convo.id, item_storage_key(provider_key, convo.item_id), convo.started_at.isoformat()),
    )
    return convo


def get(conn: sqlite3.Connection, convo_id: str) -> Conversation | None:
    row = conn.execute("SELECT * FROM conversations WHERE id = ?", (convo_id,)).fetchone()
    return _row_to_conversation(row) if row else None


def get_active_for_item(
    conn: sqlite3.Connection, item_id: str, *, provider_key: str
) -> Conversation | None:
    row = conn.execute(
        """
        SELECT * FROM conversations
        WHERE item_id = ? AND archived_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
        """,
        (item_storage_key(provider_key, item_id),),
    ).fetchone()
    return _row_to_conversation(row) if row else None


def list_for_item(
    conn: sqlite3.Connection, item_id: str, *, provider_key: str
) -> list[Conversation]:
    rows = conn.execute(
        "SELECT * FROM conversations WHERE item_id = ? ORDER BY started_at ASC",
        (item_storage_key(provider_key, item_id),),
    ).fetchall()
    return [_row_to_conversation(r) for r in rows]


def archive(conn: sqlite3.Connection, convo_id: str) -> None:
    conn.execute(
        "UPDATE conversations SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
        (now_iso(), convo_id),
    )


def add_usage(
    conn: sqlite3.Connection,
    convo_id: str,
    *,
    tokens_in: int,
    tokens_out: int,
    cost_cents: int = 0,
) -> None:
    conn.execute(
        """
        UPDATE conversations
        SET tokens_in  = tokens_in  + ?,
            tokens_out = tokens_out + ?,
            cost_cents = cost_cents + ?
        WHERE id = ?
        """,
        (tokens_in, tokens_out, cost_cents, convo_id),
    )
