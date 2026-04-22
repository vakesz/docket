"""Persistence for `Project` rows.

A project is a named (provider_key, scope_key) pair. Rows are upserted
lazily by `ensure(...)` whenever a CLI/TUI/HTTP surface activates a scope
that has not been seen before, and can be renamed / described / archived
explicitly via the project commands.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime

from docket.core.model import Project, project_id_for

_SLUG_BAD = re.compile(r"[^a-z0-9]+")


def _row_to_project(row: sqlite3.Row) -> Project:
    return Project(
        id=row["id"],
        provider_key=row["provider_key"],
        scope_key=row["scope_key"],
        name=row["name"],
        description=row["description"] or "",
        created_at=datetime.fromisoformat(row["created_at"]),
        archived_at=datetime.fromisoformat(row["archived_at"]) if row["archived_at"] else None,
    )


def _default_name(provider_key: str, scope_key: str) -> str:
    """Human-readable default — never an empty string."""
    if provider_key and scope_key:
        return f"{provider_key} · {scope_key}"
    if provider_key:
        return provider_key
    if scope_key:
        return scope_key
    return "default"


def slugify(name: str) -> str:
    """Lower-kebab slug used in URLs and CLI flags. Falls back to 'project'."""
    cleaned = _SLUG_BAD.sub("-", name.strip().lower()).strip("-")
    return cleaned or "project"


def ensure(
    conn: sqlite3.Connection,
    *,
    provider_key: str,
    scope_key: str,
    name: str | None = None,
    description: str | None = None,
) -> Project:
    """Get-or-create the project row for this (provider_key, scope_key).

    Existing rows are not overwritten — pass `name`/`description` only when
    you want to seed a fresh row. Use `update(...)` to rename later."""
    project_id = project_id_for(provider_key, scope_key)
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if row is not None:
        return _row_to_project(row)
    now = datetime.now(UTC)
    final_name = (name or _default_name(provider_key, scope_key)).strip() or "default"
    conn.execute(
        """
        INSERT INTO projects (id, provider_key, scope_key, name, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            provider_key,
            scope_key,
            final_name,
            (description or "").strip(),
            now.isoformat(),
        ),
    )
    return Project(
        id=project_id,
        provider_key=provider_key,
        scope_key=scope_key,
        name=final_name,
        description=(description or "").strip(),
        created_at=now,
    )


def get(conn: sqlite3.Connection, project_id: str) -> Project | None:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _row_to_project(row) if row else None


def list_all(conn: sqlite3.Connection, *, include_archived: bool = False) -> list[Project]:
    if include_archived:
        rows = conn.execute("SELECT * FROM projects ORDER BY name COLLATE NOCASE").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE"
        ).fetchall()
    return [_row_to_project(r) for r in rows]


def update(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
) -> Project | None:
    fields: list[str] = []
    params: list[str] = []
    if name is not None:
        fields.append("name = ?")
        params.append(name.strip() or "default")
    if description is not None:
        fields.append("description = ?")
        params.append(description.strip())
    if not fields:
        return get(conn, project_id)
    params.append(project_id)
    conn.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", params)
    return get(conn, project_id)


def archive(conn: sqlite3.Connection, project_id: str) -> None:
    conn.execute(
        "UPDATE projects SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
        (datetime.now(UTC).isoformat(), project_id),
    )


def unarchive(conn: sqlite3.Connection, project_id: str) -> None:
    conn.execute(
        "UPDATE projects SET archived_at = NULL WHERE id = ?",
        (project_id,),
    )
