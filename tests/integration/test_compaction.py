from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.agent.loop import AgentLoop
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.agent.types import Usage
from docket.core.model import Item, ItemKind, ItemState
from docket.core.services import compaction_service, conversation_service
from docket.core.services.compaction_service import SUMMARY_MARKER
from docket.storage import init_db
from docket.storage.repos import conversation_repo, message_repo
from tests.fakes.llm import FakeLlmClient, text_turn
from tests.fakes.provider import FakeProvider


def _mk_item() -> Item:
    return Item(
        id="S-1",
        kind=ItemKind.STORY,
        title="Login",
        description_md="Add login.",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    from docket.storage.repos import item_repo

    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    reg = ToolRegistry()
    register_readonly_tools(reg, conn=conn, provider=provider)
    yield conn, reg, item
    conn.close()


def test_below_threshold_noop(env) -> None:
    conn, reg, item = env
    # Low-cost turn; aggregate tokens stays tiny.
    client = FakeLlmClient(script=[text_turn("hi", usage=Usage(tokens_in=3, tokens_out=1))])
    loop = AgentLoop(client=client, tools=reg)

    conversation_service.send_user_message(
        conn,
        loop,
        item.id,
        "hello",
        compaction_threshold_tokens=10_000,
    )

    convo = conversation_repo.get_active_for_item(conn, item.id, provider_key="")
    assert convo is not None
    all_msgs = message_repo.list_for_conversation(conn, convo.id, live_only=False)
    # No summary was inserted.
    assert not any(SUMMARY_MARKER in (m.content or "") for m in all_msgs)


def test_above_threshold_compacts_old_turns(env) -> None:
    conn, reg, item = env

    # Seed a long thread: 10 turns, each worth ~200 tokens.
    turn_script = [
        text_turn(f"reply {i}", usage=Usage(tokens_in=100, tokens_out=100)) for i in range(10)
    ]
    summary_reply = text_turn("earlier: discussed scope and priorities.", usage=Usage())
    client = FakeLlmClient(script=[*turn_script, summary_reply, text_turn("next")])
    loop = AgentLoop(client=client, tools=reg)

    # Accumulate history without triggering compaction yet (threshold huge).
    for i in range(10):
        conversation_service.send_user_message(
            conn,
            loop,
            item.id,
            f"ask {i}",
            compaction_threshold_tokens=100_000,
        )

    # Sanity: we now have 20 live messages (10 user + 10 assistant).
    convo = conversation_repo.get_active_for_item(conn, item.id, provider_key="")
    assert convo is not None
    pre = message_repo.list_for_conversation(conn, convo.id, live_only=True)
    assert len(pre) == 20

    # Next turn crosses a low threshold → compaction runs first.
    result = conversation_service.send_user_message(
        conn,
        loop,
        item.id,
        "what have we learned?",
        compaction_threshold_tokens=500,
    )
    assert result.final_text == "next"

    live = message_repo.list_for_conversation(conn, convo.id, live_only=True)
    # A summary row was added; the oldest rows got flipped to compacted=1.
    assert any(SUMMARY_MARKER in (m.content or "") for m in live)
    # Live now = summary + kept tail + this turn's (user + assistant).
    assert len(live) <= compaction_service.TAIL_KEEP_MESSAGES + 3

    # Full history (live + compacted) still has everything — transcript intact.
    full = message_repo.list_for_conversation(conn, convo.id, live_only=False)
    assert len(full) > len(live)


def test_compact_now_keeps_tail_intact(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn(f"r{i}") for i in range(8)] + [text_turn("summary")])
    loop = AgentLoop(client=client, tools=reg)
    for i in range(8):
        conversation_service.send_user_message(conn, loop, item.id, f"q{i}")

    convo = conversation_repo.get_active_for_item(conn, item.id, provider_key="")
    assert convo is not None

    result = compaction_service.compact_now(conn, llm=client, convo_id=convo.id, tail_keep=4)
    assert result.compacted_message_count > 0
    assert result.summary_message_id is not None

    live = message_repo.list_for_conversation(conn, convo.id, live_only=True)
    # summary + 4 tail rows
    assert len(live) == 5
    assert SUMMARY_MARKER in live[0].content


def test_compact_now_noop_when_nothing_to_fold(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn("short")])
    loop = AgentLoop(client=client, tools=reg)
    conversation_service.send_user_message(conn, loop, item.id, "hi")

    convo = conversation_repo.get_active_for_item(conn, item.id, provider_key="")
    assert convo is not None
    result = compaction_service.compact_now(conn, llm=client, convo_id=convo.id, tail_keep=6)
    assert result.compacted_message_count == 0
    assert result.summary_message_id is None
