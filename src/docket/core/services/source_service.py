"""Project sources service.

Sources are per-project reference documents — requirements, design notes,
runbooks, anything the human curator wants the agent to be able to read on
demand. Unlike `memory`, sources have a single write path: human-driven via
CLI/TUI/HTTP. The agent reads sources through tools but cannot propose
writes; this keeps long-form reference material under human control.

Because sources do NOT ride along in the prompt prefix on every turn, this
service does not bump a revision counter. The prompt cache key is unaffected
by source edits.

The DB is the source of truth for source bodies (queryable, large,
FTS-indexed), unlike project metadata which lives in `config.toml`.
"""

from __future__ import annotations

import sqlite3

from docket.core.model import Source
from docket.storage import transaction
from docket.storage.repos import project_repo, source_repo


def _require_project(conn: sqlite3.Connection, project_id: str) -> None:
    if project_repo.get(conn, project_id) is None:
        raise KeyError(
            f"unknown project '{project_id}' "
            "— call project_service.activate() before writing sources"
        )


def list_entries(
    conn: sqlite3.Connection,
    project_id: str,
    *,
    kind: str | None = None,
    limit: int | None = None,
) -> list[Source]:
    return source_repo.list_for_project(conn, project_id, kind=kind, limit=limit)


def get_entry(conn: sqlite3.Connection, source_id: str) -> Source | None:
    return source_repo.get(conn, source_id)


def search_entries(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    *,
    kind: str | None = None,
    limit: int = 20,
) -> list[Source]:
    return source_repo.search(conn, project_id, query, kind=kind, limit=limit)


# -- direct writes (user / CLI / TUI / HTTP) --------------------------------


def add_entry(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    kind: str = "",
    uri: str = "",
    tags: list[str] | None = None,
) -> Source:
    """Create a source row directly. Wrapped in a transaction so the FTS
    triggers land atomically with the row insert."""
    _require_project(conn, project_id)
    with transaction(conn):
        return source_repo.create(
            conn,
            project_id=project_id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=tags,
        )


def edit_entry(
    conn: sqlite3.Connection,
    source_id: str,
    *,
    title: str | None = None,
    body_md: str | None = None,
    kind: str | None = None,
    uri: str | None = None,
    tags: list[str] | None = None,
) -> Source | None:
    with transaction(conn):
        return source_repo.update(
            conn,
            source_id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=tags,
        )


def remove_entry(conn: sqlite3.Connection, source_id: str) -> bool:
    with transaction(conn):
        return source_repo.delete(conn, source_id)
