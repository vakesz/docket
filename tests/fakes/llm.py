"""Scripted fake LLM client for agent tests.

Each "turn" is a list of StreamDeltas to emit. The fake returns the next
scripted turn on every `complete`/`stream` call, so tests can simulate
multi-round tool-use sequences deterministically.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

from docket.agent.llm_client import accumulate_stream
from docket.agent.types import (
    ChatMessage,
    CompletionResult,
    StreamDelta,
    ToolCallDelta,
    ToolSchema,
    Usage,
)


@dataclass
class ScriptedTurn:
    """One model response, as a sequence of streaming deltas."""

    deltas: list[StreamDelta] = field(default_factory=list)


def text_turn(text: str, *, usage: Usage | None = None) -> ScriptedTurn:
    """Convenience: build a turn that streams plain assistant text."""
    deltas: list[StreamDelta] = [StreamDelta(text=ch) for ch in text]
    deltas.append(
        StreamDelta(finish_reason="stop", usage=usage or Usage(tokens_in=5, tokens_out=len(text)))
    )
    return ScriptedTurn(deltas=deltas)


def tool_turn(
    call_id: str,
    name: str,
    arguments_json: str,
    *,
    usage: Usage | None = None,
) -> ScriptedTurn:
    """Build a turn that emits a tool_call (as a single delta) and finishes."""
    deltas: list[StreamDelta] = [
        StreamDelta(
            tool_call_delta=ToolCallDelta(
                index=0, id=call_id, name=name, arguments_fragment=arguments_json
            )
        ),
        StreamDelta(finish_reason="tool_calls", usage=usage or Usage(tokens_in=5, tokens_out=2)),
    ]
    return ScriptedTurn(deltas=deltas)


@dataclass
class FakeLlmClient:
    script: list[ScriptedTurn] = field(default_factory=list)
    calls: list[list[ChatMessage]] = field(default_factory=list)
    tool_schemas_seen: list[list[ToolSchema]] = field(default_factory=list)

    def complete(
        self,
        messages: list[ChatMessage],
        tools: list[ToolSchema],
        *,
        temperature: float = 0.2,
    ) -> CompletionResult:
        return accumulate_stream(self.stream(messages, tools, temperature=temperature))

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolSchema],
        *,
        temperature: float = 0.2,
    ) -> Iterator[StreamDelta]:
        self.calls.append(list(messages))
        self.tool_schemas_seen.append(list(tools))
        if not self.script:
            raise AssertionError("FakeLlmClient script exhausted")
        turn = self.script.pop(0)
        yield from turn.deltas
