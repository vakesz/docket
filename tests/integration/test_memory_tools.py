"""Agent memory tools — read-only and proposal-staging behavior."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from docket.agent.memory_tools import (
    register_memory_mutating_tools,
    register_memory_readonly_tools,
)
from docket.agent.tools import ToolRegistry
from docket.core.mutation import MemoryDelete, MemoryWrite
from docket.core.services import memory_service, project_service
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db


def _seed_project(conn, project_id: str = "main::default") -> str:
    from docket.config import Config, ProjectEntry

    provider, scope = project_id.split("::", 1)
    cfg = Config(
        projects={
            project_id: ProjectEntry(provider_key=provider, scope_key=scope, name="Main")
        }
    )
    project_service.mirror_into_db(cfg, conn)
    return project_id


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    pid = _seed_project(conn)
    store = ProposalStore()
    reg = ToolRegistry()
    register_memory_readonly_tools(reg, conn=conn, project_id=pid)
    register_memory_mutating_tools(reg, conn=conn, store=store, project_id=pid)
    yield conn, pid, store, reg
    conn.close()


def test_list_memory_returns_entries(env) -> None:
    conn, pid, _store, reg = env
    memory_service.add_entry(conn, project_id=pid, title="Glossary", body_md="ALM")
    out = json.loads(reg.dispatch("list_memory", {}))
    assert len(out) == 1
    assert out[0]["title"] == "Glossary"
    # body is intentionally NOT included in the cheap list view
    assert "body_md" not in out[0]


def test_recall_memory_full_text_search(env) -> None:
    conn, pid, _store, reg = env
    memory_service.add_entry(conn, project_id=pid, title="Auth", body_md="OAuth tokens")
    memory_service.add_entry(conn, project_id=pid, title="Other", body_md="unrelated")
    out = json.loads(reg.dispatch("recall_memory", {"query": "OAuth"}))
    assert [e["title"] for e in out] == ["Auth"]
    # body included in search hits so the agent doesn't need a follow-up call
    assert out[0]["body_md"] == "OAuth tokens"


def test_recall_memory_requires_query(env) -> None:
    _, _, _, reg = env
    out = json.loads(reg.dispatch("recall_memory", {}))
    assert "error" in out


def test_propose_memory_write_stages_proposal(env) -> None:
    _, _, store, reg = env
    out = reg.dispatch(
        "propose_memory_write",
        {"title": "Decision", "body_md": "Use JWT.", "tags": ["adr"]},
    )
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert payload["kind"] == "memory_write"
    assert len(store) == 1
    pending = store.list()[0]
    assert isinstance(pending.proposal, MemoryWrite)
    assert pending.proposal.memory_id is None  # create


def test_propose_memory_write_requires_fields(env) -> None:
    _, _, store, reg = env
    out = json.loads(reg.dispatch("propose_memory_write", {"title": "x"}))
    assert "error" in out
    assert len(store) == 0


def test_propose_memory_write_for_unknown_id(env) -> None:
    _, _, store, reg = env
    out = json.loads(
        reg.dispatch(
            "propose_memory_write",
            {"title": "x", "body_md": "y", "memory_id": "ghost"},
        )
    )
    assert "unknown memory entry" in out["error"]
    assert len(store) == 0


def test_propose_memory_delete_stages(env) -> None:
    conn, pid, store, reg = env
    entry = memory_service.add_entry(conn, project_id=pid, title="Tmp", body_md="")
    out = json.loads(reg.dispatch("propose_memory_delete", {"memory_id": entry.id}))
    assert out["status"] == "pending_confirmation"
    assert isinstance(store.list()[0].proposal, MemoryDelete)
    # Entry still exists; the proposal hasn't been confirmed yet.
    assert memory_service.get_entry(conn, entry.id) is not None
