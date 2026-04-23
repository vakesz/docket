from __future__ import annotations

import json

from docket.agent.loop import AgentLoop
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn


def _registry_with(name: str, handler) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(
        name=name,
        description=f"{name} tool",
        parameters={"type": "object", "properties": {"x": {"type": "string"}}},
        handler=handler,
    )
    return reg


def test_single_turn_no_tools() -> None:
    client = FakeLlmClient(script=[text_turn("Hello there.")])
    loop = AgentLoop(client=client, tools=ToolRegistry())
    turn = loop.run_turn(
        prefix=[ChatMessage(role="system", content="sys")],
        history=[],
        user_message=ChatMessage(role="user", content="Hi"),
    )
    assert turn.final.role == "assistant"
    assert turn.final.content == "Hello there."
    assert turn.rounds == 1
    # user + assistant
    assert [m.role for m in turn.new_messages] == ["user", "assistant"]


def test_tool_call_round_then_final_text() -> None:
    calls: list[dict] = []

    def handler(args: dict) -> str:
        calls.append(args)
        return json.dumps({"result": "42"})

    client = FakeLlmClient(
        script=[
            tool_turn("tc-1", "oracle", '{"x":"hello"}'),
            text_turn("Answer is 42."),
        ]
    )
    reg = _registry_with("oracle", handler)
    loop = AgentLoop(client=client, tools=reg)

    turn = loop.run_turn(
        prefix=[],
        history=[],
        user_message=ChatMessage(role="user", content="what?"),
    )
    assert turn.rounds == 2
    assert turn.final.content == "Answer is 42."
    assert calls == [{"x": "hello"}]
    roles = [m.role for m in turn.new_messages]
    assert roles == ["user", "assistant", "tool", "assistant"]
    # Tool result message carries the call id and name
    tool_msg = turn.new_messages[2]
    assert tool_msg.tool_call_id == "tc-1"
    assert tool_msg.name == "oracle"


def test_max_rounds_bound() -> None:
    # Infinite tool-call loop — the guard must stop at max_tool_rounds, then
    # make one more no-tools completion so the user sees a text answer rather
    # than a blank tool-dispatch message.
    client = FakeLlmClient(
        script=[
            tool_turn("tc-1", "noop", "{}"),
            tool_turn("tc-2", "noop", "{}"),
            tool_turn("tc-3", "noop", "{}"),
            text_turn("I'm out of tool budget — here's what I found so far."),
        ]
    )
    reg = _registry_with("noop", lambda _: "{}")
    loop = AgentLoop(client=client, tools=reg, max_tool_rounds=3)
    turn = loop.run_turn(
        prefix=[],
        history=[],
        user_message=ChatMessage(role="user", content="loop"),
    )
    assert turn.rounds == 3
    assert turn.final.content.startswith("I'm out of tool budget")
    assert not turn.final.tool_calls
    # The final no-tools completion must be called with an empty tools list.
    assert client.tool_schemas_seen[-1] == []


def test_stream_callback_fires_on_each_delta() -> None:
    client = FakeLlmClient(script=[text_turn("Hey")])
    loop = AgentLoop(client=client, tools=ToolRegistry())
    chunks: list[str] = []
    loop.run_turn(
        prefix=[],
        history=[],
        user_message=ChatMessage(role="user", content="."),
        on_delta=lambda d: chunks.append(d.text),
    )
    # "Hey" → three text deltas + one finish delta (no text)
    assert "".join(chunks) == "Hey"


def test_unknown_tool_returns_structured_error() -> None:
    client = FakeLlmClient(
        script=[
            tool_turn("tc-1", "does_not_exist", "{}"),
            text_turn("done"),
        ]
    )
    loop = AgentLoop(client=client, tools=ToolRegistry())
    turn = loop.run_turn(
        prefix=[],
        history=[],
        user_message=ChatMessage(role="user", content="q"),
    )
    tool_msg = next(m for m in turn.new_messages if m.role == "tool")
    payload = json.loads(tool_msg.content)
    assert "unknown tool" in payload["error"]
