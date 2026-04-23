"""Source repo + service tests.

Covers direct CRUD, FTS search, kind filtering, and the `_require_project`
guard that protects the FK to `projects(id)`. Sources do NOT bump a
revision counter (unlike memory) because they don't ride in the prompt
prefix on every turn.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.core.services import project_service, source_service
from docket.storage import init_db
from docket.storage.repos import source_repo


def _seed_project(conn, project_id: str = "main") -> str:
    project_service.mirror_into_db(_minimal_config(project_id), conn)
    return project_id


def _minimal_config(project_id: str):
    from docket.config import Config, ProjectEntry

    return Config(
        projects={
            project_id: ProjectEntry(provider_key=project_id, name="Main")
        }
    )


def test_add_entry_persists(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)

    entry = source_service.add_entry(
        conn,
        project_id=pid,
        title="Login spec",
        body_md="## Goals\nAuth via OAuth.",
        kind="requirements",
        uri="https://example.test/spec",
        tags=["auth"],
    )
    assert entry.id
    assert entry.title == "Login spec"
    assert entry.kind == "requirements"
    assert entry.uri == "https://example.test/spec"
    assert entry.tags == ["auth"]

    rows = source_service.list_entries(conn, pid)
    assert len(rows) == 1
    assert rows[0].id == entry.id
    conn.close()


def test_edit_entry_updates_only_supplied_fields(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    entry = source_service.add_entry(
        conn, project_id=pid, title="A", body_md="x", kind="design"
    )

    updated = source_service.edit_entry(conn, entry.id, body_md="y")
    assert updated is not None
    assert updated.title == "A"  # unchanged
    assert updated.body_md == "y"
    assert updated.kind == "design"  # unchanged
    conn.close()


def test_remove_entry_returns_false_when_missing(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    _seed_project(conn)
    assert source_service.remove_entry(conn, "nope") is False
    conn.close()


def test_search_uses_fts_and_scopes_to_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid_a = _seed_project(conn, "p1")
    pid_b = _seed_project(conn, "p2")
    source_service.add_entry(
        conn, project_id=pid_a, title="Auth flow", body_md="OAuth tokens"
    )
    source_service.add_entry(
        conn, project_id=pid_a, title="Other", body_md="unrelated"
    )
    source_service.add_entry(
        conn, project_id=pid_b, title="Auth notes", body_md="OAuth"
    )

    matches = source_service.search_entries(conn, pid_a, "OAuth")
    assert {m.title for m in matches} == {"Auth flow"}
    # Empty/whitespace query -> no results, not an error.
    assert source_service.search_entries(conn, pid_a, "   ") == []
    conn.close()


def test_search_quotes_user_punctuation(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    source_service.add_entry(conn, project_id=pid, title="Curly", body_md="C++ syntax")
    matches = source_service.search_entries(conn, pid, "C++")
    assert len(matches) == 1
    conn.close()


def test_kind_filter(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    source_service.add_entry(
        conn, project_id=pid, title="Spec", body_md="x", kind="requirements"
    )
    source_service.add_entry(
        conn, project_id=pid, title="Diag", body_md="y", kind="design"
    )

    only_design = source_service.list_entries(conn, pid, kind="design")
    assert {e.title for e in only_design} == {"Diag"}
    only_design_search = source_service.search_entries(conn, pid, "x", kind="requirements")
    assert {e.title for e in only_design_search} == {"Spec"}
    conn.close()


def test_add_entry_rejects_unknown_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    with pytest.raises(KeyError):
        source_service.add_entry(conn, project_id="ghost", title="x", body_md="y")
    conn.close()


def test_list_for_project_respects_limit(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    for i in range(5):
        source_service.add_entry(conn, project_id=pid, title=f"E{i}", body_md="")
    rows = source_repo.list_for_project(conn, pid, limit=3)
    assert len(rows) == 3
    conn.close()
