from __future__ import annotations

from pathlib import Path

import pytest

from docket.agent.loop import AgentLoop
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.services import conversation_service
from docket.storage import init_db
from docket.storage.repos import conversation_repo, item_repo, message_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    reg = ToolRegistry()
    register_readonly_tools(reg, conn=conn, provider=provider)
    yield conn, reg, item
    conn.close()


def test_first_message_starts_thread_and_persists(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn("Hi!")])
    loop = AgentLoop(client=client, tools=reg)

    result = conversation_service.send_user_message(conn, loop, item.id, "Hello")

    # Conversation exists and is active
    active = conversation_repo.get_active_for_item(conn, item.id, provider_key="")
    assert active is not None
    assert active.id == result.conversation.id
    # Messages persisted (user + assistant)
    msgs = message_repo.list_for_conversation(conn, active.id)
    assert [m.role for m in msgs] == ["user", "assistant"]
    assert msgs[-1].content == "Hi!"
    # Token counters updated on the conversation row
    assert active.tokens_in == 5
    assert active.tokens_out == 3


def test_second_message_continues_same_thread(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn("one"), text_turn("two")])
    loop = AgentLoop(client=client, tools=reg)

    conversation_service.send_user_message(conn, loop, item.id, "first")
    conversation_service.send_user_message(conn, loop, item.id, "second")

    convos = conversation_repo.list_for_item(conn, item.id, provider_key="")
    assert len(convos) == 1
    msgs = message_repo.list_for_conversation(conn, convos[0].id)
    assert [m.role for m in msgs] == ["user", "assistant", "user", "assistant"]


def test_new_thread_archives_previous(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn("one")])
    loop = AgentLoop(client=client, tools=reg)

    first = conversation_service.send_user_message(conn, loop, item.id, "hi").conversation
    second = conversation_service.new_thread(conn, item.id)

    assert second.id != first.id
    first_after = conversation_repo.get(conn, first.id)
    assert first_after is not None
    assert first_after.archived_at is not None


def test_tool_roundtrip_persists_tool_message(env) -> None:
    conn, reg, item = env
    # First turn: model asks for get_item; second turn: final text.
    client = FakeLlmClient(
        script=[
            tool_turn("tc-1", "get_item", '{"id":"S-1"}'),
            text_turn("seen it"),
        ]
    )
    loop = AgentLoop(client=client, tools=reg)

    result = conversation_service.send_user_message(conn, loop, item.id, "summarize")

    msgs = message_repo.list_for_conversation(conn, result.conversation.id)
    roles = [m.role for m in msgs]
    assert roles == ["user", "assistant", "tool", "assistant"]
    tool_msg = msgs[2]
    assert tool_msg.tool_call_id == "tc-1"
    assert tool_msg.name == "get_item"
    # The tool round-tripped real cache data
    assert "Login" in tool_msg.content


def test_history_feeds_back_into_prompt(env) -> None:
    conn, reg, item = env
    client = FakeLlmClient(script=[text_turn("first"), text_turn("second")])
    loop = AgentLoop(client=client, tools=reg)

    conversation_service.send_user_message(conn, loop, item.id, "turn one")
    conversation_service.send_user_message(conn, loop, item.id, "turn two")

    # Second LLM call should include the prior user+assistant turn in its messages.
    second_call = client.calls[1]
    roles_in_call = [m.role for m in second_call]
    # prefix (system x2) + prior user + prior assistant + new user
    assert roles_in_call.count("user") == 2
    assert roles_in_call.count("assistant") == 1
