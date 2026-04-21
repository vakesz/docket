from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime

from docket.core.model import Item, ItemKind, ItemState


def _row_to_item(row: sqlite3.Row) -> Item:
    url: str | None
    try:
        url = row["url"]
    except (IndexError, KeyError):
        url = None
    return Item(
        id=row["id"],
        kind=ItemKind(row["kind"]),
        title=row["title"],
        description_md=row["description_md"],
        state=ItemState(row["state"]),
        assignee=row["assignee"],
        parent_id=row["parent_id"],
        tags=json.loads(row["tags_json"]),
        updated_at=datetime.fromisoformat(row["updated_at"]) if row["updated_at"] else None,
        url=url,
        provider_raw=json.loads(row["provider_raw"]),
    )


def upsert_item(conn: sqlite3.Connection, item: Item) -> None:
    conn.execute(
        """
        INSERT INTO items (
            id, kind, title, description_md, state, assignee, parent_id,
            tags_json, provider_raw, updated_at, synced_at, archived, url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
            kind           = excluded.kind,
            title          = excluded.title,
            description_md = excluded.description_md,
            state          = excluded.state,
            assignee       = excluded.assignee,
            parent_id      = excluded.parent_id,
            tags_json      = excluded.tags_json,
            provider_raw   = excluded.provider_raw,
            updated_at     = excluded.updated_at,
            synced_at      = excluded.synced_at,
            archived       = 0,
            url            = COALESCE(excluded.url, items.url)
        """,
        (
            item.id,
            item.kind.value,
            item.title,
            item.description_md,
            item.state.value,
            item.assignee,
            item.parent_id,
            json.dumps(item.tags),
            json.dumps(item.provider_raw, default=str),
            item.updated_at.isoformat() if item.updated_at else "",
            datetime.now(UTC).isoformat(),
            item.url,
        ),
    )


def upsert_items(conn: sqlite3.Connection, items: Iterable[Item]) -> int:
    n = 0
    for it in items:
        upsert_item(conn, it)
        n += 1
    return n


def get_item(conn: sqlite3.Connection, id: str) -> Item | None:
    row = conn.execute("SELECT * FROM items WHERE id = ?", (id,)).fetchone()
    return _row_to_item(row) if row else None


def list_items(
    conn: sqlite3.Connection,
    *,
    kind: ItemKind | None = None,
    parent_id: str | None = None,
    include_archived: bool = False,
) -> list[Item]:
    clauses: list[str] = []
    params: list[object] = []
    if kind is not None:
        clauses.append("kind = ?")
        params.append(kind.value)
    if parent_id is not None:
        clauses.append("parent_id = ?")
        params.append(parent_id)
    if not include_archived:
        clauses.append("archived = 0")
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM items {where} ORDER BY updated_at DESC",
        params,
    ).fetchall()
    return [_row_to_item(r) for r in rows]


def iter_items(conn: sqlite3.Connection) -> Iterator[Item]:
    for row in conn.execute("SELECT * FROM items ORDER BY updated_at DESC"):
        yield _row_to_item(row)


def mark_archived(conn: sqlite3.Connection, ids: Iterable[str]) -> int:
    ids_list = list(ids)
    if not ids_list:
        return 0
    placeholders = ",".join("?" for _ in ids_list)
    cur = conn.execute(f"UPDATE items SET archived = 1 WHERE id IN ({placeholders})", ids_list)
    return cur.rowcount
