"""Persistence for per-project `MemoryEntry` rows + revision counters.

Memory is the agent's durable knowledge of a project: glossary terms, design
decisions, conventions, pitfalls. Each row is plain Markdown so a human can
read and edit it directly. Rows are scoped to a project (`projects.id` FK)
and recreated when the project is removed.

Two tables back this:

- `memory` — the rows themselves, with FTS5 indexed via triggers in schema.py.
- `memory_revisions` — one int per project, bumped on every write. The
  prompt-prefix builder reads it to key the LLM's prompt cache: same
  revision → same bytes → cache hit.

Writes always go through `bump_revision` so the prefix invalidates on
exactly the same boundary the model sees the change. Each mutating
function wraps the row write + FTS triggers + revision bump in one
transaction so they land atomically.
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import UTC, datetime

from docket.core.model import MemoryEntry
from docket.storage.db import transaction
from docket.storage.repos import project_repo


def _row_to_entry(row: sqlite3.Row) -> MemoryEntry:
    raw_tags = row["tags_json"] or "[]"
    try:
        tags = list(json.loads(raw_tags))
    except (TypeError, ValueError):
        tags = []
    return MemoryEntry(
        id=row["id"],
        project_id=row["project_id"],
        title=row["title"],
        body_md=row["body_md"],
        tags=[str(t) for t in tags],
        source=row["source"] or "user",
        created_at=datetime.fromisoformat(row["created_at"]),
        updated_at=datetime.fromisoformat(row["updated_at"]),
    )


def list_for_project(
    conn: sqlite3.Connection, project_id: str, *, limit: int | None = None
) -> list[MemoryEntry]:
    """Most-recently-updated first. Pass `limit` to cap results for the prompt."""
    sql = "SELECT * FROM memory WHERE project_id = ? ORDER BY updated_at DESC, id ASC"
    params: tuple[object, ...] = (project_id,)
    if limit is not None and limit > 0:
        sql += " LIMIT ?"
        params = (project_id, limit)
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_entry(r) for r in rows]


def get(conn: sqlite3.Connection, memory_id: str) -> MemoryEntry | None:
    row = conn.execute("SELECT * FROM memory WHERE id = ?", (memory_id,)).fetchone()
    return _row_to_entry(row) if row else None


def create(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    tags: list[str] | None = None,
    source: str = "user",
) -> MemoryEntry:
    """Insert a new memory row and bump the project's revision.

    Raises `KeyError` if the project is unknown."""
    project_repo.require_project(conn, project_id)
    now = datetime.now(UTC)
    memory_id = str(uuid.uuid4())
    tags_clean = [t.strip() for t in (tags or []) if t and t.strip()]
    with transaction(conn):
        conn.execute(
            """
            INSERT INTO memory
                (id, project_id, title, body_md, tags_json, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memory_id,
                project_id,
                title.strip() or "(untitled)",
                body_md,
                json.dumps(tags_clean),
                source,
                now.isoformat(),
                now.isoformat(),
            ),
        )
        bump_revision(conn, project_id)
    return MemoryEntry(
        id=memory_id,
        project_id=project_id,
        title=title.strip() or "(untitled)",
        body_md=body_md,
        tags=tags_clean,
        source=source,
        created_at=now,
        updated_at=now,
    )


def update(
    conn: sqlite3.Connection,
    memory_id: str,
    *,
    title: str | None = None,
    body_md: str | None = None,
    tags: list[str] | None = None,
) -> MemoryEntry | None:
    """Patch one row, bump the owning project's revision. No-op fields stay."""
    existing = get(conn, memory_id)
    if existing is None:
        return None
    fields: list[str] = []
    params: list[object] = []
    if title is not None:
        fields.append("title = ?")
        params.append(title.strip() or "(untitled)")
    if body_md is not None:
        fields.append("body_md = ?")
        params.append(body_md)
    if tags is not None:
        cleaned = [t.strip() for t in tags if t and t.strip()]
        fields.append("tags_json = ?")
        params.append(json.dumps(cleaned))
    if not fields:
        return existing
    fields.append("updated_at = ?")
    params.append(datetime.now(UTC).isoformat())
    params.append(memory_id)
    with transaction(conn):
        row = conn.execute(
            f"UPDATE memory SET {', '.join(fields)} WHERE id = ? RETURNING *", params
        ).fetchone()
        bump_revision(conn, existing.project_id)
    return _row_to_entry(row) if row else None


def delete(conn: sqlite3.Connection, memory_id: str) -> bool:
    row = conn.execute("SELECT project_id FROM memory WHERE id = ?", (memory_id,)).fetchone()
    if row is None:
        return False
    with transaction(conn):
        conn.execute("DELETE FROM memory WHERE id = ?", (memory_id,))
        bump_revision(conn, row["project_id"])
    return True


def upsert_for_proposal(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    tags: list[str],
    source: str,
    memory_id: str | None,
) -> MemoryEntry:
    """Apply a confirmed `MemoryWrite` proposal: create-or-update by id.

    If `memory_id` is None, create a new row. Otherwise update the row in
    place. If the edit target vanished between proposal and confirm, fall
    through to a fresh create rather than failing silently."""
    if memory_id is None:
        return create(
            conn,
            project_id=project_id,
            title=title,
            body_md=body_md,
            tags=tags,
            source=source,
        )
    updated = update(
        conn,
        memory_id,
        title=title,
        body_md=body_md,
        tags=tags,
    )
    if updated is None:
        return create(
            conn,
            project_id=project_id,
            title=title,
            body_md=body_md,
            tags=tags,
            source=source,
        )
    return updated


def search(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    *,
    limit: int = 20,
) -> list[MemoryEntry]:
    """FTS5-backed search scoped to one project. Best-match first.

    Sanitization: an empty/whitespace query returns []. The query string is
    quoted so user-typed punctuation can't break the FTS5 syntax."""
    cleaned = query.strip()
    if not cleaned:
        return []
    quoted = '"' + cleaned.replace('"', '""') + '"'
    rows = conn.execute(
        """
        SELECT m.* FROM memory_fts f
        JOIN memory m ON m.id = f.memory_id
        WHERE f.project_id = ? AND memory_fts MATCH ?
        ORDER BY bm25(memory_fts)
        LIMIT ?
        """,
        (project_id, quoted, max(1, limit)),
    ).fetchall()
    return [_row_to_entry(r) for r in rows]


# -- revisions ---------------------------------------------------------------


def get_revision(conn: sqlite3.Connection, project_id: str) -> int:
    """Current memory revision for a project; 0 when no rows exist yet.

    The prompt-prefix builder includes this number in its cache key so any
    write invalidates exactly one project's cache without touching others."""
    row = conn.execute(
        "SELECT revision FROM memory_revisions WHERE project_id = ?", (project_id,)
    ).fetchone()
    return int(row["revision"]) if row else 0


def bump_revision(conn: sqlite3.Connection, project_id: str) -> int:
    """Increment (or initialize) the project's revision counter; return new value."""
    now = datetime.now(UTC).isoformat()
    conn.execute(
        """
        INSERT INTO memory_revisions (project_id, revision, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(project_id) DO UPDATE SET
            revision = revision + 1,
            updated_at = excluded.updated_at
        """,
        (project_id, now),
    )
    return get_revision(conn, project_id)


__all__ = [
    "bump_revision",
    "create",
    "delete",
    "get",
    "get_revision",
    "list_for_project",
    "search",
    "update",
    "upsert_for_proposal",
]
