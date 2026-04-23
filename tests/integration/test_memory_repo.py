"""Memory repo tests.

Covers direct CRUD, FTS search, revision counter behavior, and the
`_require_project` guard that protects the FK to `projects(id)`."""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.core.services import project_service
from docket.storage import init_db
from docket.storage.repos import memory_repo


def _seed_project(conn, project_id: str = "main") -> str:
    project_service.mirror_into_db(_minimal_config(project_id), conn)
    return project_id


def _minimal_config(project_id: str):
    from docket.config import Config, ProjectEntry

    return Config(projects={project_id: ProjectEntry(provider_key=project_id, name="Main")})


def test_add_entry_persists_and_bumps_revision(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    assert memory_repo.get_revision(conn, pid) == 0

    entry = memory_repo.create(
        conn, project_id=pid, title="Glossary", body_md="**ALM**: …", tags=["ref"]
    )
    assert entry.id
    assert entry.title == "Glossary"
    assert entry.tags == ["ref"]
    assert entry.source == "user"
    assert memory_repo.get_revision(conn, pid) == 1

    rows = memory_repo.list_for_project(conn, pid)
    assert len(rows) == 1
    assert rows[0].id == entry.id
    conn.close()


def test_edit_entry_updates_only_supplied_fields(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    entry = memory_repo.create(conn, project_id=pid, title="A", body_md="x")
    rev_before = memory_repo.get_revision(conn, pid)

    updated = memory_repo.update(conn, entry.id, body_md="y")
    assert updated is not None
    assert updated.title == "A"  # unchanged
    assert updated.body_md == "y"
    assert memory_repo.get_revision(conn, pid) == rev_before + 1
    conn.close()


def test_remove_entry_returns_false_when_missing(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    _seed_project(conn)
    assert memory_repo.delete(conn, "nope") is False
    conn.close()


def test_search_uses_fts_and_scopes_to_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid_a = _seed_project(conn, "p1")
    pid_b = _seed_project(conn, "p2")
    memory_repo.create(conn, project_id=pid_a, title="Auth flow", body_md="OAuth tokens")
    memory_repo.create(conn, project_id=pid_a, title="Other", body_md="unrelated")
    memory_repo.create(conn, project_id=pid_b, title="Auth notes", body_md="OAuth")

    matches = memory_repo.search(conn, pid_a, "OAuth")
    assert {m.title for m in matches} == {"Auth flow"}
    # Empty query -> no results, not an error.
    assert memory_repo.search(conn, pid_a, "   ") == []
    conn.close()


def test_search_quotes_user_punctuation(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    memory_repo.create(conn, project_id=pid, title="Curly", body_md="C++ syntax")
    # The "+" character is FTS5-significant; the repo quotes the query so this
    # used to crash with a syntax error.
    matches = memory_repo.search(conn, pid, "C++")
    assert len(matches) == 1
    conn.close()


def test_add_entry_rejects_unknown_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    with pytest.raises(KeyError):
        memory_repo.create(conn, project_id="ghost", title="x", body_md="y")
    conn.close()


def test_list_for_project_respects_limit(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    for i in range(5):
        memory_repo.create(conn, project_id=pid, title=f"E{i}", body_md="")
    rows = memory_repo.list_for_project(conn, pid, limit=3)
    assert len(rows) == 3
    conn.close()
