from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Iterator, Sequence
from datetime import UTC, datetime

from docket.core.model import Item, ItemKind, ItemState
from docket.storage.item_keys import item_storage_key


def row_to_item(row: sqlite3.Row) -> Item:
    return Item(
        id=row["provider_item_id"],
        kind=ItemKind(row["kind"]),
        title=row["title"],
        description_md=row["description_md"],
        state=ItemState(row["state"]),
        assignee=row["assignee"],
        parent_id=row["parent_id"],
        tags=json.loads(row["tags_json"]),
        updated_at=datetime.fromisoformat(row["updated_at"]) if row["updated_at"] else None,
        url=row["url"],
        author=row["author"],
        repository_url=row["repository_url"],
        provider_raw=json.loads(row["provider_raw"]),
        provider_key=row["provider_key"],
    )


_UPSERT_SQL = """
INSERT INTO items (
    id, provider_key, provider_item_id, kind, title, description_md, state, assignee, parent_id,
    tags_json, provider_raw, updated_at, synced_at, archived, url, author, repository_url
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    provider_key    = excluded.provider_key,
    provider_item_id = excluded.provider_item_id,
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
    url            = COALESCE(excluded.url, items.url),
    author         = COALESCE(excluded.author, items.author),
    repository_url = COALESCE(excluded.repository_url, items.repository_url)
"""


def _upsert_row(item: Item, now_iso: str) -> tuple[object, ...]:
    return (
        item_storage_key(item.provider_key, item.id),
        item.provider_key,
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
        now_iso,
        item.url,
        item.author,
        item.repository_url,
    )


def upsert_item(conn: sqlite3.Connection, item: Item) -> None:
    now_iso = datetime.now(UTC).isoformat()
    conn.execute(_UPSERT_SQL, _upsert_row(item, now_iso))


def upsert_items(conn: sqlite3.Connection, items: Iterable[Item]) -> int:
    """Bulk upsert via a single `executemany`. On a fresh sync of ~1k items
    this collapses 1k individual `execute` round-trips into one call — the
    per-item Python ↔ sqlite bridging cost is what dominated the old loop."""
    now_iso = datetime.now(UTC).isoformat()
    rows = [_upsert_row(it, now_iso) for it in items]
    if not rows:
        return 0
    conn.executemany(_UPSERT_SQL, rows)
    return len(rows)


def get_item(conn: sqlite3.Connection, id: str, *, provider_key: str | None = None) -> Item | None:
    if provider_key:
        row = conn.execute(
            "SELECT * FROM items WHERE id = ?",
            (item_storage_key(provider_key, id),),
        ).fetchone()
        return row_to_item(row) if row else None
    rows = conn.execute(
        "SELECT * FROM items WHERE provider_item_id = ? ORDER BY updated_at DESC",
        (id,),
    ).fetchall()
    if len(rows) > 1:
        raise RuntimeError(f"ambiguous cached item id={id!r}; pass provider_key")
    row = rows[0] if rows else None
    return row_to_item(row) if row else None


def list_items(
    conn: sqlite3.Connection,
    *,
    kind: ItemKind | None = None,
    states: Iterable[ItemState] | None = None,
    tag: str | None = None,
    parent_id: str | None = None,
    include_archived: bool = False,
    provider_key: str | None = None,
    assignee: str | None = None,
) -> list[Item]:
    """List cached items, optionally narrowed by axis.

    `assignee` is the post-cache visual filter's "who" — callers resolve
    `@me` via `visual_filter.resolve` and pass the concrete identity here.
    An empty or `None` assignee means "don't narrow on this axis"."""
    clauses: list[str] = []
    params: list[object] = []
    if kind is not None:
        clauses.append("kind = ?")
        params.append(kind.value)
    if states is not None:
        state_values = [s.value for s in states]
        if not state_values:
            # Explicit empty filter — caller asked for nothing, give them nothing.
            return []
        placeholders = ",".join("?" for _ in state_values)
        clauses.append(f"state IN ({placeholders})")
        params.extend(state_values)
    if tag is not None:
        # tags_json is a JSON array of strings; JSON1's `json_each` gives us
        # a sub-select that matches exact values (case-sensitive, which aligns
        # with how GitHub/Azure DevOps treat labels).
        clauses.append(
            "EXISTS (SELECT 1 FROM json_each(items.tags_json) WHERE json_each.value = ?)"
        )
        params.append(tag)
    if parent_id is not None:
        clauses.append("parent_id = ?")
        params.append(parent_id)
    if not include_archived:
        clauses.append("archived = 0")
    if provider_key:
        clauses.append("provider_key = ?")
        params.append(provider_key)
    if assignee:
        clauses.append("assignee = ?")
        params.append(assignee)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM items {where} ORDER BY updated_at DESC",
        params,
    ).fetchall()
    return [row_to_item(r) for r in rows]


def list_items_by_ids(
    conn: sqlite3.Connection,
    ids: Sequence[str],
    *,
    provider_key: str | None = None,
    states: Iterable[ItemState] | None = None,
) -> list[Item]:
    """Fetch a specific set of items by provider_item_id.

    Avoids scanning the full cache when only a known subset of ids is needed
    (e.g. the result set returned by search_repo.search)."""
    if not ids:
        return []
    placeholders = ",".join("?" for _ in ids)
    clauses: list[str] = [
        "archived = 0",
        f"provider_item_id IN ({placeholders})",
    ]
    params: list[object] = list(ids)
    if provider_key:
        clauses.append("provider_key = ?")
        params.append(provider_key)
    if states is not None:
        state_values = [s.value for s in states]
        if not state_values:
            return []
        ph = ",".join("?" for _ in state_values)
        clauses.append(f"state IN ({ph})")
        params.extend(state_values)
    rows = conn.execute(
        f"SELECT * FROM items WHERE {' AND '.join(clauses)}",
        params,
    ).fetchall()
    return [row_to_item(r) for r in rows]


def iter_items(conn: sqlite3.Connection, *, provider_key: str | None = None) -> Iterator[Item]:
    if provider_key:
        cur = conn.execute(
            "SELECT * FROM items WHERE provider_key = ? ORDER BY updated_at DESC",
            (provider_key,),
        )
    else:
        cur = conn.execute("SELECT * FROM items ORDER BY updated_at DESC")
    for row in cur:
        yield row_to_item(row)


def mark_archived(
    conn: sqlite3.Connection, ids: Iterable[str], *, provider_key: str | None = None
) -> int:
    ids_list = list(ids)
    if not ids_list:
        return 0
    placeholders = ",".join("?" for _ in ids_list)
    if provider_key:
        storage_ids = [item_storage_key(provider_key, item_id) for item_id in ids_list]
        cur = conn.execute(
            f"UPDATE items SET archived = 1 WHERE id IN ({placeholders})",
            storage_ids,
        )
    else:
        cur = conn.execute(
            f"UPDATE items SET archived = 1 WHERE provider_item_id IN ({placeholders})",
            ids_list,
        )
    return cur.rowcount
