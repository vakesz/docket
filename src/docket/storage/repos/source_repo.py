"""Persistence for per-project `Source` rows.

Sources are reference documents (requirements, design notes, runbooks)
attached to a project. The agent can read them on demand via tools but
cannot modify them — writes only flow from human users via CLI/TUI/HTTP.

Unlike `memory`, sources are NOT shipped in the prompt prefix on every
turn, so there is no revision counter: the prompt cache key does not
depend on source content. FTS5 indexing is driven by triggers in
`schema.py`; mutating functions wrap the row write + FTS triggers in
one transaction so they land atomically.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from docket.core.model import Source
from docket.storage.db import transaction
from docket.storage.repos import project_repo
from docket.storage.repos._tags import clean_tags, clean_title, parse_tags


def _row_to_entry(row: sqlite3.Row) -> Source:
    return Source(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"],
        body_md=row["body_md"],
        kind=row["kind"] or "",
        uri=row["uri"] or "",
        tags=parse_tags(row["tags_json"]),
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def list_for_project(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    kind: str | None = None,
    limit: int | None = None,
) -> list[Source]:
    """Most-recently-updated first, optionally filtered by `kind`."""
    sql = "SELECT * FROM sources WHERE project_id = ?"
    params: list[object] = [project_id]
    if kind is not None and kind.strip():
        sql += " AND kind = ?"
        params.append(kind.strip())
    sql += " ORDER BY updated_at DESC, id ASC"
    if limit is not None and limit > 0:
        sql += " LIMIT ?"
        params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_entry(r) for r in rows]


def get(conn: sqlite3.Connection, source_id: str) -> Source | None:
    row = conn.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
    return _row_to_entry(row) if row else None


def create(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    kind: str = "",
    uri: str = "",
    tags: list[str] | None = None,
) -> Source:
    """Insert a new source row. Raises `KeyError` if the project is unknown."""
    project_repo.require_project(conn, project_id)
    now = datetime.now(UTC)
    source_id = str(uuid.uuid4())
    tags_clean = clean_tags(tags)
    with transaction(conn):
        conn.execute(
            """
            INSERT INTO sources
                (id, project_id, title, kind, uri, body_md, tags_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_id,
                project_id,
                clean_title(title),
                kind.strip(),
                uri.strip(),
                body_md,
                json.dumps(tags_clean),
                now.isoformat(),
                now.isoformat(),
            ),
        )
    return Source(
        id=source_id,
        project_id=project_id,
        title=clean_title(title),
        body_md=body_md,
        kind=kind.strip(),
        uri=uri.strip(),
        tags=tags_clean,
        created_at=now,
        updated_at=now,
    )


def update(
    conn: sqlite3.Connection,
    source_id: str,
    *,
    title: str | None = None,
    body_md: str | None = None,
    kind: str | None = None,
    uri: str | None = None,
    tags: list[str] | None = None,
) -> Source | None:
    """Patch one row. No-op fields stay."""
    existing = get(conn, source_id)
    if existing is None:
        return None
    fields: list[tuple[str, object]] = []
    if title is not None:
        fields.append(("title", clean_title(title)))
    if body_md is not None:
        fields.append(("body_md", body_md))
    if kind is not None:
        fields.append(("kind", kind.strip()))
    if uri is not None:
        fields.append(("uri", uri.strip()))
    if tags is not None:
        fields.append(("tags_json", json.dumps(clean_tags(tags))))
    if not fields:
        return existing
    cols = [f"{name} = ?" for name, _ in fields] + ["updated_at = ?"]
    params: list[object] = [val for _, val in fields]
    params.append(datetime.now(UTC).isoformat())
    params.append(source_id)
    with transaction(conn):
        conn.execute(f"UPDATE sources SET {', '.join(cols)} WHERE id = ?", params)
    return get(conn, source_id)


def delete(conn: sqlite3.Connection, source_id: str) -> bool:
    existing = get(conn, source_id)
    if existing is None:
        return False
    with transaction(conn):
        conn.execute("DELETE FROM sources WHERE id = ?", (source_id,))
    return True


def search(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    *,
    kind: str | None = None,
    limit: int = 20,
) -> list[Source]:
    """FTS5-backed search scoped to one project. Best-match first.

    Sanitization: an empty/whitespace query returns []. The query string is
    quoted so user-typed punctuation can't break the FTS5 syntax. Pass
    `kind` to narrow results to one category."""
    cleaned = query.strip()
    if not cleaned:
        return []
    quoted = '"' + cleaned.replace('"', '""') + '"'
    sql = (
        "SELECT s.* FROM sources_fts f "
        "JOIN sources s ON s.id = f.source_id "
        "WHERE f.project_id = ? AND sources_fts MATCH ?"
    )
    params: list[object] = [project_id, quoted]
    if kind is not None and kind.strip():
        sql += " AND s.kind = ?"
        params.append(kind.strip())
    sql += " ORDER BY bm25(sources_fts) LIMIT ?"
    params.append(max(1, limit))
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_entry(r) for r in rows]


__all__ = [
    "create",
    "delete",
    "get",
    "list_for_project",
    "search",
    "update",
]
