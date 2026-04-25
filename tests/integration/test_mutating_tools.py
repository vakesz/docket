from __future__ import annotations

import json
from pathlib import Path

import pytest

from docket.agent.factory import register_readonly_tools
from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.tools import ToolRegistry
from docket.core.model import ItemState
from docket.core.mutation import CommentAdd, DescriptionPatch, ItemCreate, StateChange
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.provider import FakeProvider


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item(description_md="Original description.")
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    store = ProposalStore()
    reg = ToolRegistry()
    register_readonly_tools(reg, conn=conn, provider=provider)
    register_mutating_tools(
        reg, conn=conn, store=store, active_item=lambda: item.id, provider=provider
    )
    yield conn, provider, store, reg, item
    conn.close()


def test_propose_transition_stages_but_does_not_execute(env) -> None:
    _conn, provider, store, reg, item = env
    out = reg.dispatch("propose_transition", {"id": item.id, "intent": "start_work"})
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert payload["kind"] == "state_change"
    assert len(store) == 1
    pending = store.list()[0]
    assert isinstance(pending.proposal, StateChange)
    # Provider was NOT touched — no item state change on the fake.
    assert provider.items[0].state == ItemState.NEW


def test_propose_transition_unknown_intent(env) -> None:
    _, _, store, reg, item = env
    out = reg.dispatch("propose_transition", {"id": item.id, "intent": "teleport"})
    assert "unknown intent" in json.loads(out)["error"]
    assert len(store) == 0


def test_propose_description_patch_includes_diff(env) -> None:
    _, _, store, reg, item = env
    out = reg.dispatch(
        "propose_description_patch",
        {"id": item.id, "new_description_md": "Rewritten."},
    )
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert "Rewritten" in payload["diff"]
    assert isinstance(store.list()[0].proposal, DescriptionPatch)


def test_propose_new_item_without_parent(env) -> None:
    _, _, store, reg, _ = env
    out = reg.dispatch(
        "propose_new_item",
        {"kind": "task", "title": "Write docs", "description_md": "TBD"},
    )
    assert json.loads(out)["status"] == "pending_confirmation"
    pending = store.list()[0]
    assert isinstance(pending.proposal, ItemCreate)
    assert pending.proposal.fields.title == "Write docs"


def test_propose_new_item_surfaces_duplicates(env) -> None:
    """When the title matches an existing cached item, the tool payload must
    carry a `similar` list so the agent can reconsider before the human sees
    the diff modal. The proposal still stages — the user has final say."""
    _conn, _provider, store, reg, item = env  # cached item has title "Login"
    out = reg.dispatch(
        "propose_new_item",
        {"kind": "task", "title": "Login redesign", "description_md": ""},
    )
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert payload.get("similar"), "duplicate-check should surface cached matches"
    assert any(s["id"] == item.id for s in payload["similar"])
    assert len(store) == 1


def test_propose_new_item_no_duplicates_omits_key(env) -> None:
    """No match → no `similar` key, to keep the payload tight."""
    _, _, _, reg, _ = env
    out = reg.dispatch(
        "propose_new_item",
        {"kind": "task", "title": "Zzz unrelated widget", "description_md": ""},
    )
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert "similar" not in payload


def test_propose_comment_stages_pending_proposal(env) -> None:
    _, provider, store, reg, item = env
    out = reg.dispatch(
        "propose_comment",
        {"id": item.id, "body_md": "Triaged — no repro yet."},
    )
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert payload["kind"] == "comment_add"
    assert "Triaged" in payload["diff"]
    pending = store.list()[0]
    assert isinstance(pending.proposal, CommentAdd)
    # Provider untouched until confirmation.
    assert provider.comments.get(item.id, []) == []


def test_propose_comment_rejects_empty_body(env) -> None:
    _, _, store, reg, item = env
    out = reg.dispatch("propose_comment", {"id": item.id, "body_md": "   "})
    assert "non-empty body_md" in json.loads(out)["error"]
    assert len(store) == 0


def test_unknown_item_returns_error(env) -> None:
    _, _, store, reg, _ = env
    out = reg.dispatch("propose_transition", {"id": "no-such", "intent": "start_work"})
    assert "no cached item" in json.loads(out)["error"]
    assert len(store) == 0
