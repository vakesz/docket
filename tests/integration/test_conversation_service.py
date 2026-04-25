from __future__ import annotations

import json
from pathlib import Path

import pytest

from docket.agent.loop import AgentLoop
from docket.agent.question_tool import register_ask_user_tool
from docket.agent.factory import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.question import QuestionAnswer
from docket.core.services import conversation_service
from docket.core.services.question_store import QuestionStore
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


# -- ask_user / question flow ----------------------------------------------


def _build_ask_user_loop(
    conn, item, question_store: QuestionStore
) -> tuple[AgentLoop, FakeLlmClient]:
    """Loop pre-wired with the readonly toolset plus `ask_user`. Returns the
    loop and the (still-empty) FakeLlmClient so the caller can script turns."""
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=conn, provider=FakeProvider(items=[item]))
    client = FakeLlmClient(script=[])
    loop = AgentLoop(client=client, tools=registry)
    register_ask_user_tool(
        registry,
        store=question_store,
        conversation_id=loop.current_conversation_id,
        current_tool_call_id=loop.current_tool_call_id,
    )
    return loop, client


_ASK_ARGS = json.dumps(
    {
        "questions": [
            {
                "question": "Pick one",
                "header": "Pick",
                "options": [
                    {"label": "alpha"},
                    {"label": "beta"},
                ],
            }
        ]
    }
)


def test_ask_user_stages_question_and_persists_pending_tool_result(env) -> None:
    conn, _reg, item = env
    qstore = QuestionStore()
    loop, client = _build_ask_user_loop(conn, item, qstore)
    client.script = [tool_turn("tc-q1", "ask_user", _ASK_ARGS)]

    result = conversation_service.send_user_message(
        conn, loop, item.id, "should I do X?", question_store=qstore
    )

    assert result.pending_question is not None
    assert result.pending_question.tool_call_id == "tc-q1"
    pending_in_store = qstore.peek(("", "", result.conversation.id))
    assert pending_in_store is result.pending_question

    msgs = message_repo.list_for_conversation(conn, result.conversation.id)
    assert [m.role for m in msgs] == ["user", "assistant", "tool"]
    tool_row = msgs[-1]
    assert tool_row.tool_call_id == "tc-q1"
    # The placeholder content is the awaiting sentinel, JSON-encoded.
    payload = json.loads(tool_row.content)
    assert payload["status"] == "awaiting_answer"


def test_submit_question_answer_resumes_turn(env) -> None:
    conn, _reg, item = env
    qstore = QuestionStore()
    loop, client = _build_ask_user_loop(conn, item, qstore)
    # Turn 1: ask_user.  Turn 2: model says "thanks" after the answer.
    client.script = [
        tool_turn("tc-q1", "ask_user", _ASK_ARGS),
        text_turn("got it"),
    ]

    first = conversation_service.send_user_message(
        conn, loop, item.id, "should I do X?", question_store=qstore
    )
    assert first.pending_question is not None

    answers = (QuestionAnswer(selected=("alpha",)),)
    second = conversation_service.submit_question_answer(
        conn,
        loop,
        item.id,
        first.pending_question.id,
        answers,
        question_store=qstore,
    )

    # Question is gone, model got the chance to reply.
    assert qstore.peek(("", "", first.conversation.id)) is None
    assert second.final_text == "got it"
    assert second.pending_question is None

    # The placeholder tool-result was rewritten with the structured answer.
    msgs = message_repo.list_for_conversation(conn, first.conversation.id)
    tool_row = next(m for m in msgs if m.role == "tool")
    body = json.loads(tool_row.content)
    assert body["status"] == "answered"
    assert body["answers"][0]["selected"] == ["alpha"]


def test_free_text_while_question_pending_redirects_as_other(env) -> None:
    """User typing a regular chat message while a card is open is treated as
    free-text for the first question — same code path as picking 'Other'."""
    conn, _reg, item = env
    qstore = QuestionStore()
    loop, client = _build_ask_user_loop(conn, item, qstore)
    client.script = [
        tool_turn("tc-q1", "ask_user", _ASK_ARGS),
        text_turn("noted"),
    ]

    first = conversation_service.send_user_message(
        conn, loop, item.id, "advise me", question_store=qstore
    )
    assert first.pending_question is not None

    # Second message arrives WITHOUT going through /answer.
    second = conversation_service.send_user_message(
        conn, loop, item.id, "actually, gamma", question_store=qstore
    )
    assert second.final_text == "noted"
    assert qstore.peek(("", "", first.conversation.id)) is None

    msgs = message_repo.list_for_conversation(conn, first.conversation.id)
    tool_row = next(m for m in msgs if m.role == "tool")
    body = json.loads(tool_row.content)
    assert body["status"] == "answered"
    assert body["answers"][0]["other"] == "actually, gamma"


def test_submit_question_answer_rejects_mismatched_id(env) -> None:
    conn, _reg, item = env
    qstore = QuestionStore()
    loop, client = _build_ask_user_loop(conn, item, qstore)
    client.script = [tool_turn("tc-q1", "ask_user", _ASK_ARGS)]

    first = conversation_service.send_user_message(conn, loop, item.id, "?", question_store=qstore)
    assert first.pending_question is not None

    with pytest.raises(KeyError):
        conversation_service.submit_question_answer(
            conn,
            loop,
            item.id,
            "not-the-real-id",
            (QuestionAnswer(other_text="x"),),
            question_store=qstore,
        )
