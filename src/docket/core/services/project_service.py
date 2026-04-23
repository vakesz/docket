"""Project service: TOML is source of truth, SQLite mirrors it.

Project metadata (name, description, archived) lives in `config.toml` under
`[projects."<provider_key>"]`. The SQLite `projects` table is a mirror used
as a foreign-key target for memory, sources, and sub-agents. A project IS a
provider: every scope on that provider shares the same project row, and
memory/sources/MCP are not split by scope.

Lifecycle:

1. On startup (`prepare()` / `serve` boot), `mirror_into_db(config, conn)`
   walks `config.projects` and upserts every row, lazily seeding one for
   the active provider if it doesn't have explicit metadata yet.
2. Mutations (`upsert`, `rename`, `describe`, `archive`) edit the in-memory
   `Config`, persist via `save_config`, then re-mirror.
3. CLI/TUI/HTTP read from `config.projects` for display, and from the DB
   only for FK joins.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from docket.config.loader import save_config
from docket.config.models import Config, ProjectEntry
from docket.config.paths import Paths
from docket.core.model import Project, project_id_for
from docket.storage.repos import project_repo


def _entry_to_project(entry: ProjectEntry, project_id: str) -> Project:
    return Project(
        id=project_id,
        provider_key=entry.provider_key,
        name=entry.name,
        description=entry.description,
        created_at=None,
        archived_at=datetime.now(UTC) if entry.archived else None,
    )


def _default_name(provider_key: str) -> str:
    return provider_key or "default"


def mirror_into_db(config: Config, conn: sqlite3.Connection) -> None:
    """Reflect `config.projects` into the SQLite mirror.

    Existing DB rows for providers not in the config are left untouched —
    content (memory, sources) still references them and you should remove
    the underlying provider through setup, not by deleting from the project
    table directly."""
    for project_id, entry in config.projects.items():
        existing = project_repo.get(conn, project_id)
        if existing is None:
            project_repo.ensure(
                conn,
                provider_key=entry.provider_key,
                name=entry.name,
                description=entry.description,
            )
        else:
            project_repo.update(conn, project_id, name=entry.name, description=entry.description)
        if entry.archived:
            project_repo.archive(conn, project_id)
        else:
            project_repo.unarchive(conn, project_id)


def upsert(
    config: Config,
    paths: Paths,
    conn: sqlite3.Connection,
    *,
    provider_key: str,
    name: str | None = None,
    description: str | None = None,
) -> Project:
    """Create or update a project entry in TOML, then mirror to DB.

    Returns the resulting `Project`. Idempotent: passing only the key
    creates a default-named entry if missing and is a no-op otherwise."""
    project_id = project_id_for(provider_key)
    existing = config.projects.get(project_id)
    final_name = (
        name if name is not None else (existing.name if existing else None)
    ) or _default_name(provider_key)
    final_description = (
        description if description is not None else (existing.description if existing else "")
    )
    config.projects[project_id] = ProjectEntry(
        provider_key=provider_key,
        name=final_name.strip() or "default",
        description=final_description.strip(),
        archived=existing.archived if existing else False,
        mcp=dict(existing.mcp) if existing else {},
    )
    save_config(paths, config)
    mirror_into_db(config, conn)
    project = project_repo.get(conn, project_id)
    assert project is not None  # mirror_into_db just created it
    return project


def activate(
    config: Config,
    paths: Paths,
    conn: sqlite3.Connection,
    *,
    provider_key: str,
) -> Project:
    """Ensure a project row for the active provider.

    Lazily seeds a default entry if none exists. Surfaces should call this
    immediately after switching provider."""
    project_id = project_id_for(provider_key)
    if project_id not in config.projects:
        return upsert(
            config,
            paths,
            conn,
            provider_key=provider_key,
        )
    project_repo.ensure(
        conn,
        provider_key=provider_key,
        name=config.projects[project_id].name,
        description=config.projects[project_id].description,
    )
    project = project_repo.get(conn, project_id)
    assert project is not None
    return project


def get(conn: sqlite3.Connection, project_id: str) -> Project | None:
    return project_repo.get(conn, project_id)


def get_by_provider(conn: sqlite3.Connection, *, provider_key: str) -> Project | None:
    return project_repo.get(conn, project_id_for(provider_key))


def list_all(conn: sqlite3.Connection, *, include_archived: bool = False) -> list[Project]:
    return project_repo.list_all(conn, include_archived=include_archived)


def rename(
    config: Config,
    paths: Paths,
    conn: sqlite3.Connection,
    project_id: str,
    new_name: str,
) -> Project | None:
    entry = config.projects.get(project_id)
    if entry is None:
        return None
    entry.name = new_name.strip() or "default"
    save_config(paths, config)
    mirror_into_db(config, conn)
    return get(conn, project_id)


def describe(
    config: Config,
    paths: Paths,
    conn: sqlite3.Connection,
    project_id: str,
    description: str,
) -> Project | None:
    entry = config.projects.get(project_id)
    if entry is None:
        return None
    entry.description = description.strip()
    save_config(paths, config)
    mirror_into_db(config, conn)
    return get(conn, project_id)


def archive(config: Config, paths: Paths, conn: sqlite3.Connection, project_id: str) -> None:
    entry = config.projects.get(project_id)
    if entry is None:
        return
    entry.archived = True
    save_config(paths, config)
    mirror_into_db(config, conn)


def unarchive(config: Config, paths: Paths, conn: sqlite3.Connection, project_id: str) -> None:
    entry = config.projects.get(project_id)
    if entry is None:
        return
    entry.archived = False
    save_config(paths, config)
    mirror_into_db(config, conn)
