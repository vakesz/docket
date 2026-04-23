"""Agent turn loop.

Given a user message, a prefix, and a tool registry, the loop:
  1. Calls the LLM with messages = prefix + history + new user message.
  2. If the response has tool_calls, dispatches each, appends the assistant
     message + tool-result messages to the transcript, and repeats.
  3. If the response has no tool_calls (or we hit `max_tool_rounds`), returns
     the final assistant message plus aggregated usage.

The loop does not persist anything — conversation_service handles that after
the loop returns.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field

from docket.agent.llm_client import LlmClient, accumulate_stream
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage, CompletionResult, StreamDelta, ToolCall, Usage


@dataclass
class AgentTurn:
    """Output of one user turn: all new messages generated, plus totals.

    `new_messages` is appended to conversation history in order; it always
    starts with assistant turns and may interleave tool results."""

    final: ChatMessage
    new_messages: list[ChatMessage] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    rounds: int = 0


class AgentLoop:
    def __init__(
        self,
        *,
        client: LlmClient,
        tools: ToolRegistry,
        max_tool_rounds: int = 5,
        stream: bool = True,
    ) -> None:
        self._client = client
        self._tools = tools
        self._max_rounds = max_tool_rounds
        self._stream = stream

    @property
    def client(self) -> LlmClient:
        """Exposed so services (e.g. compaction) can issue side-channel calls
        with the same client without plumbing a second handle through."""
        return self._client

    def run_turn(
        self,
        *,
        prefix: list[ChatMessage],
        history: list[ChatMessage],
        user_message: ChatMessage,
        on_delta: Callable[[StreamDelta], None] | None = None,
        on_message: Callable[[ChatMessage], None] | None = None,
    ) -> AgentTurn:
        new_messages: list[ChatMessage] = [user_message]
        total = Usage()
        rounds = 0

        working: list[ChatMessage] = list(prefix) + list(history) + [user_message]

        while True:
            rounds += 1
            result = self._complete(working, on_delta=on_delta)
            total.tokens_in += result.usage.tokens_in
            total.tokens_out += result.usage.tokens_out
            total.cached_tokens_in += result.usage.cached_tokens_in

            assistant_msg = result.message
            new_messages.append(assistant_msg)
            working.append(assistant_msg)
            if on_message:
                on_message(assistant_msg)

            if not assistant_msg.tool_calls:
                return AgentTurn(
                    final=assistant_msg,
                    new_messages=new_messages,
                    usage=total,
                    rounds=rounds,
                )

            for tc in assistant_msg.tool_calls:
                tool_result_msg = self._dispatch(tc)
                new_messages.append(tool_result_msg)
                working.append(tool_result_msg)
                if on_message:
                    on_message(tool_result_msg)

            if rounds >= self._max_rounds:
                # Budget exhausted while the model still wants to call tools.
                # Force a final text completion (no tools offered) so the user
                # sees a summary / options instead of a blank assistant card.
                final_result = self._complete(working, on_delta=on_delta, with_tools=False)
                total.tokens_in += final_result.usage.tokens_in
                total.tokens_out += final_result.usage.tokens_out
                total.cached_tokens_in += final_result.usage.cached_tokens_in
                final_msg = final_result.message
                new_messages.append(final_msg)
                if on_message:
                    on_message(final_msg)
                return AgentTurn(
                    final=final_msg,
                    new_messages=new_messages,
                    usage=total,
                    rounds=rounds,
                )

    # -- internals ----------------------------------------------------------

    def _complete(
        self,
        messages: list[ChatMessage],
        *,
        on_delta: Callable[[StreamDelta], None] | None = None,
        with_tools: bool = True,
    ) -> CompletionResult:
        schemas = self._tools.schemas() if with_tools else []
        if self._stream:
            stream = self._client.stream(messages, schemas)
            if on_delta is not None:
                stream = _tap(stream, on_delta)
            return accumulate_stream(stream)
        return self._client.complete(messages, schemas)

    def _dispatch(self, tc: ToolCall) -> ChatMessage:
        content = self._tools.dispatch(tc.name, tc.arguments)
        return ChatMessage(
            role="tool",
            content=content,
            tool_call_id=tc.id,
            name=tc.name,
        )


def _tap(
    stream: Iterable[StreamDelta],
    callback: Callable[[StreamDelta], None],
) -> Iterator[StreamDelta]:
    """Yield deltas while invoking a callback on each. Callback failures
    must not break the stream — they're UI-side concerns."""
    for delta in stream:
        with contextlib.suppress(Exception):  # nosec - UI callback errors are non-fatal
            callback(delta)
        yield delta


def message_to_json(m: ChatMessage) -> dict[str, object]:
    """Serialize a message to a JSON-ready dict for persistence."""
    out: dict[str, object] = {
        "role": m.role,
        "content": m.content,
    }
    if m.tool_calls:
        out["tool_calls"] = [
            {"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in m.tool_calls
        ]
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.name:
        out["name"] = m.name
    return out


def message_from_json(payload: dict[str, object]) -> ChatMessage:
    tool_calls_raw = payload.get("tool_calls") or []
    tool_calls: list[ToolCall] = []
    if isinstance(tool_calls_raw, list):
        for tc in tool_calls_raw:
            if not isinstance(tc, dict):
                continue
            args = tc.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            tool_calls.append(
                ToolCall(
                    id=str(tc.get("id", "")),
                    name=str(tc.get("name", "")),
                    arguments=args if isinstance(args, dict) else {},
                )
            )
    role_val = str(payload.get("role", "user"))
    tool_call_id = payload.get("tool_call_id")
    name = payload.get("name")
    # Narrow to the Literal via constructor — ChatMessage accepts the string.
    return ChatMessage(
        role=role_val,  # type: ignore[arg-type]
        content=str(payload.get("content") or ""),
        tool_calls=tool_calls,
        tool_call_id=tool_call_id if isinstance(tool_call_id, str) else None,
        name=name if isinstance(name, str) else None,
    )
