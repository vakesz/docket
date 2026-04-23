"""Memory mutation flow: propose → confirm."""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.core.mutation import MemoryDelete, MemoryWrite, render_diff
from docket.core.services import memory_service, mutation_service, project_service
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


def _seed_project(conn, project_id: str = "main") -> str:
    from docket.config import Config, ProjectEntry

    cfg = Config(projects={project_id: ProjectEntry(provider_key=project_id, name="Main")})
    project_service.mirror_into_db(cfg, conn)
    return project_id


def test_propose_memory_write_create_and_confirm(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    proposal = mutation_service.propose_memory_write(
        conn, project_id=pid, title="Glossary", body_md="ALM = …", tags=["ref"]
    )
    assert isinstance(proposal, MemoryWrite)
    assert proposal.memory_id is None  # create
    diff = render_diff(proposal)
    assert "Glossary" in diff

    result = mutation_service.confirm(conn, FakeProvider(), proposal)
    assert result.memory is not None
    assert result.memory.title == "Glossary"
    assert result.memory.source == "agent"  # default for proposed writes

    # And it's actually persisted.
    rows = memory_service.list_entries(conn, pid)
    assert len(rows) == 1
    conn.close()


def test_propose_memory_write_edit_carries_previous(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    existing = memory_service.add_entry(conn, project_id=pid, title="Old title", body_md="Old body")
    proposal = mutation_service.propose_memory_write(
        conn,
        project_id=pid,
        title="New title",
        body_md="New body",
        memory_id=existing.id,
    )
    assert proposal.memory_id == existing.id
    assert proposal.previous_title == "Old title"
    assert proposal.previous_body_md == "Old body"
    # Diff shows the actual change, not just the new content.
    diff = render_diff(proposal)
    assert "Old body" in diff and "New body" in diff

    result = mutation_service.confirm(conn, FakeProvider(), proposal)
    assert result.memory is not None
    assert result.memory.id == existing.id
    assert result.memory.body_md == "New body"
    conn.close()


def test_propose_memory_write_rejects_cross_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid_a = _seed_project(conn, "a")
    pid_b = _seed_project(conn, "b")
    entry_b = memory_service.add_entry(conn, project_id=pid_b, title="B", body_md="")
    with pytest.raises(ValueError, match="belongs to project"):
        mutation_service.propose_memory_write(
            conn,
            project_id=pid_a,
            title="hijack",
            body_md="x",
            memory_id=entry_b.id,
        )
    conn.close()


def test_confirm_memory_delete_removes_row(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    entry = memory_service.add_entry(conn, project_id=pid, title="Tmp", body_md="x")
    proposal = mutation_service.propose_memory_delete(conn, project_id=pid, memory_id=entry.id)
    assert isinstance(proposal, MemoryDelete)

    result = mutation_service.confirm(conn, FakeProvider(), proposal)
    assert result.memory_deleted_id == entry.id
    assert memory_service.get_entry(conn, entry.id) is None
    conn.close()


def test_confirm_memory_write_dry_run(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    proposal = mutation_service.propose_memory_write(conn, project_id=pid, title="x", body_md="y")
    result = mutation_service.confirm(conn, FakeProvider(), proposal, dry_run=True)
    assert result.dry_run is True
    assert result.memory is None
    # No row was created.
    assert memory_service.list_entries(conn, pid) == []
    conn.close()
