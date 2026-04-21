"""End-to-end coverage of the `attach_transcript` mutating tool.

Exercises the full path: a conversation exists with user/assistant messages,
the agent calls `attach_transcript`, and the resulting `AttachmentUpload`
proposal carries a correctly-versioned filename plus Markdown whose content
matches the cached messages. Confirming the proposal must then route through
`mutation_service.confirm` to the provider.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage
from docket.core.model import Item, ItemKind, ItemState
from docket.core.mutation import AttachmentUpload
from docket.core.services import conversation_service, mutation_service
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import conversation_repo, item_repo, message_repo
from tests.fakes.provider import FakeProvider


def _mk_item() -> Item:
    return Item(
        id="S-1",
        kind=ItemKind.STORY,
        title="Login flow",
        description_md="x",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    store = ProposalStore()
    reg = ToolRegistry()
    register_readonly_tools(reg, conn=conn, provider=provider)
    register_mutating_tools(reg, conn=conn, store=store, active_item=lambda: item.id)
    # Seed a conversation so the transcript tool has something to render.
    convo = conversation_service.open_thread(conn, item.id)
    message_repo.append(conn, convo.id, ChatMessage(role="user", content="Why is this blocked?"))
    message_repo.append(
        conn,
        convo.id,
        ChatMessage(role="assistant", content="Looking into it."),
        tokens_out=7,
    )
    yield conn, provider, store, reg, item, convo
    conn.close()


def test_attach_transcript_produces_versioned_proposal(env) -> None:
    conn, _, store, reg, item, _ = env
    out = reg.dispatch("attach_transcript", {"id": item.id})
    payload = json.loads(out)
    assert payload["status"] == "pending_confirmation"
    assert payload["kind"] == "attachment_upload"

    pending = store.list()[0]
    assert isinstance(pending.proposal, AttachmentUpload)
    assert pending.proposal.filename == "convo-001.md"
    content = pending.proposal.content.decode("utf-8")
    assert "Why is this blocked?" in content
    assert "Looking into it." in content
    assert item.id in content
    assert item.title in content


def test_attach_transcript_uses_active_item_when_id_missing(env) -> None:
    _, _, store, reg, _, _ = env
    out = reg.dispatch("attach_transcript", {})
    assert json.loads(out)["status"] == "pending_confirmation"
    assert isinstance(store.list()[0].proposal, AttachmentUpload)


def test_attach_transcript_errors_when_no_conversation(env) -> None:
    conn, provider, store, _, _, convo = env
    # Archive the seeded convo so there is no active one.
    conversation_repo.archive(conn, convo.id)
    # Fresh registry after archive — the original `store` still holds nothing.
    reg = ToolRegistry()
    register_readonly_tools(reg, conn=conn, provider=provider)
    register_mutating_tools(reg, conn=conn, store=store, active_item=lambda: "S-1")
    out = reg.dispatch("attach_transcript", {"id": "S-1"})
    assert "no active conversation" in json.loads(out)["error"]
    assert len(store) == 0


def test_confirm_routes_attachment_through_provider_and_increments_version(env) -> None:
    conn, provider, store, reg, item, _ = env
    reg.dispatch("attach_transcript", {"id": item.id})
    proposal = store.list()[0].proposal
    assert isinstance(proposal, AttachmentUpload)

    result = mutation_service.confirm(conn, provider, proposal)
    assert result.attachment_url == "https://fake/attachments/convo-001.md"
    assert provider.uploaded == [(item.id, "convo-001.md", proposal.content)]
    store.pop(proposal.id)

    # A second attachment should land on convo-002.md, derived from the
    # attachments table written by mutation_service.confirm.
    reg.dispatch("attach_transcript", {"id": item.id})
    next_proposal = store.list()[0].proposal
    assert isinstance(next_proposal, AttachmentUpload)
    assert next_proposal.filename == "convo-002.md"
