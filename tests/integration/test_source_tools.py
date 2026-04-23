"""Agent source tools — read-only behavior.

Sources are reference material curated by humans. The agent has list /
read / search tools but no propose_* tool, so this suite never touches a
ProposalStore.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from docket.agent.source_tools import register_source_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.services import project_service
from docket.storage import init_db
from docket.storage.repos import source_repo


def _seed_project(conn, project_id: str = "main") -> str:
    from docket.config import Config, ProjectEntry

    cfg = Config(projects={project_id: ProjectEntry(provider_key=project_id, name="Main")})
    project_service.mirror_into_db(cfg, conn)
    return project_id


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    reg = ToolRegistry()
    register_source_readonly_tools(reg, conn=conn, project_id=pid)
    yield conn, pid, reg
    conn.close()


def test_list_sources_returns_summaries(env) -> None:
    conn, pid, reg = env
    source_repo.create(conn, project_id=pid, title="Spec", body_md="big body", kind="requirements")
    out = json.loads(reg.dispatch("list_sources", {}))
    assert len(out) == 1
    assert out[0]["title"] == "Spec"
    assert out[0]["kind"] == "requirements"
    # Body is intentionally NOT in the cheap list view.
    assert "body_md" not in out[0]


def test_list_sources_kind_filter(env) -> None:
    conn, pid, reg = env
    source_repo.create(conn, project_id=pid, title="A", body_md="", kind="design")
    source_repo.create(conn, project_id=pid, title="B", body_md="", kind="runbook")
    out = json.loads(reg.dispatch("list_sources", {"kind": "design"}))
    assert [e["title"] for e in out] == ["A"]


def test_read_source_returns_body(env) -> None:
    conn, pid, reg = env
    entry = source_repo.create(
        conn, project_id=pid, title="Doc", body_md="full text", kind="design"
    )
    out = json.loads(reg.dispatch("read_source", {"source_id": entry.id}))
    assert out["title"] == "Doc"
    assert out["body_md"] == "full text"


def test_read_source_requires_id(env) -> None:
    _, _, reg = env
    out = json.loads(reg.dispatch("read_source", {}))
    assert "error" in out


def test_read_source_blocks_cross_project(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid_a = _seed_project(conn, "p1")
    pid_b = _seed_project(conn, "p2")
    other = source_repo.create(conn, project_id=pid_b, title="Secret", body_md="hush")
    reg = ToolRegistry()
    register_source_readonly_tools(reg, conn=conn, project_id=pid_a)
    out = json.loads(reg.dispatch("read_source", {"source_id": other.id}))
    assert "error" in out
    conn.close()


def test_search_sources_full_text(env) -> None:
    conn, pid, reg = env
    source_repo.create(conn, project_id=pid, title="Auth", body_md="OAuth tokens")
    source_repo.create(conn, project_id=pid, title="Other", body_md="unrelated")
    out = json.loads(reg.dispatch("search_sources", {"query": "OAuth"}))
    assert [e["title"] for e in out] == ["Auth"]
    # Body included in search hits so the agent doesn't need a follow-up call.
    assert out[0]["body_md"] == "OAuth tokens"


def test_search_sources_requires_query(env) -> None:
    _, _, reg = env
    out = json.loads(reg.dispatch("search_sources", {}))
    assert "error" in out
