"""Project memory service.

Memory is the agent's per-project knowledge: glossary, design decisions,
conventions, pitfalls. Two write paths converge here:

- **User-driven** (CLI `docket memory add/edit/rm`, TUI MemoryPane edits,
  HTTP `POST/PATCH/DELETE`): direct writes via this module's `add_entry`,
  `edit_entry`, `remove_entry`. No proposal, no confirmation — the human
  is doing it themselves.
- **Agent-driven** (the `propose_memory_write` tool): goes through
  `mutation_service.propose_memory_write` → confirm modal →
  `mutation_service.confirm`, which calls back into this module via
  `apply_memory_write` / `apply_memory_delete`. The confirm gate is the
  guardrail between the model and durable state.

Both paths bump the project's revision counter, which the prompt-prefix
builder reads to key the LLM cache: same revision → same memory bytes →
prompt cache hit on the next turn.

The DB is the source of truth for memory bodies (queryable, large, FTS-indexed),
unlike project metadata which lives in `config.toml`.
"""

from __future__ import annotations

import sqlite3

from docket.core.model import MemoryEntry
from docket.storage import transaction
from docket.storage.repos import memory_repo, project_repo


def _require_project(conn: sqlite3.Connection, project_id: str) -> None:
    if project_repo.get(conn, project_id) is None:
        raise KeyError(
            f"unknown project '{project_id}' "
            "— call project_service.activate() before writing memory"
        )


def list_entries(
    conn: sqlite3.Connection, project_id: str, *, limit: int | None = None
) -> list[MemoryEntry]:
    return memory_repo.list_for_project(conn, project_id, limit=limit)


def get_entry(conn: sqlite3.Connection, memory_id: str) -> MemoryEntry | None:
    return memory_repo.get(conn, memory_id)


def search_entries(
    conn: sqlite3.Connection, project_id: str, query: str, *, limit: int = 20
) -> list[MemoryEntry]:
    return memory_repo.search(conn, project_id, query, limit=limit)


def get_revision(conn: sqlite3.Connection, project_id: str) -> int:
    return memory_repo.get_revision(conn, project_id)


# -- direct writes (user / CLI / TUI / HTTP) --------------------------------


def add_entry(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    tags: list[str] | None = None,
    source: str = "user",
) -> MemoryEntry:
    """Create a memory row directly. Wrapped in a transaction so the FTS
    triggers and the revision bump land atomically."""
    _require_project(conn, project_id)
    with transaction(conn):
        return memory_repo.create(
            conn,
            project_id=project_id,
            title=title,
            body_md=body_md,
            tags=tags,
            source=source,
        )


def edit_entry(
    conn: sqlite3.Connection,
    memory_id: str,
    *,
    title: str | None = None,
    body_md: str | None = None,
    tags: list[str] | None = None,
) -> MemoryEntry | None:
    with transaction(conn):
        return memory_repo.update(
            conn,
            memory_id,
            title=title,
            body_md=body_md,
            tags=tags,
        )


def remove_entry(conn: sqlite3.Connection, memory_id: str) -> bool:
    with transaction(conn):
        return memory_repo.delete(conn, memory_id)


# -- mutation-service callbacks (agent path, post-confirm) -------------------


def apply_memory_write(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    tags: list[str],
    source: str,
    memory_id: str | None,
) -> MemoryEntry:
    """Apply a confirmed `MemoryWrite` proposal. Create-or-update by id.

    Called from `mutation_service.confirm`. Don't call this from a UI; use
    `add_entry` / `edit_entry` for the direct user path so the source field
    is right and there's no proposal-store baggage."""
    _require_project(conn, project_id)
    with transaction(conn):
        if memory_id is None:
            return memory_repo.create(
                conn,
                project_id=project_id,
                title=title,
                body_md=body_md,
                tags=tags,
                source=source,
            )
        updated = memory_repo.update(
            conn,
            memory_id,
            title=title,
            body_md=body_md,
            tags=tags,
        )
        if updated is None:
            # Edit target vanished between proposal and confirm — treat as
            # a fresh create rather than failing silently.
            return memory_repo.create(
                conn,
                project_id=project_id,
                title=title,
                body_md=body_md,
                tags=tags,
                source=source,
            )
        return updated


def apply_memory_delete(conn: sqlite3.Connection, memory_id: str) -> bool:
    with transaction(conn):
        return memory_repo.delete(conn, memory_id)
