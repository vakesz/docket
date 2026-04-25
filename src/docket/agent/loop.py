"""Agent turn loop.

Given a user message, a prefix, and a tool registry, the loop:
  1. Calls the LLM with messages = prefix + history + new user message.
  2. If the response has tool_calls, dispatches each, appends the assistant
     message + tool-result messages to the transcript, and repeats.
  3. If the response has no tool_calls (or we hit `max_tool_rounds`), returns
     the final assistant message plus aggregated usage.

The loop does not persist anything — conversation_service handles that after
the loop returns.

When a tool returns the `ask_user` awaiting-answer sentinel, the loop ends
the turn early after persisting the staged tool-result as a placeholder.
Any other tool calls in the same assistant response are discarded — the
agent must wait for the user before doing more work.
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import TypeGuard, get_args

from docket.agent.llm_client import LlmClient, accumulate_stream
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage, ChatRole, CompletionResult, StreamDelta, ToolCall, Usage
from docket.core.question import is_awaiting
from docket.telemetry.logging import get_logger

_CHAT_ROLES: frozenset[str] = frozenset(get_args(ChatRole))
_log = get_logger(__name__)


def _is_chat_role(value: str) -> TypeGuard[ChatRole]:
    return value in _CHAT_ROLES


@dataclass
class AgentTurn:
    """Output of one user turn: all new messages generated, plus totals.

    `new_messages` is appended to conversation history in order; it always
    starts with assistant turns and may interleave tool results.
    `awaiting_answer=True` signals that `ask_user` was called and the turn
    ended early — the trailing tool-result message is a placeholder that
    the conversation service must persist with `pending=1`."""

    final: ChatMessage
    new_messages: list[ChatMessage] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)
    rounds: int = 0
    awaiting_answer: bool = False


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
        self._current_tool_call_id: str = ""
        self._current_conversation_id: str = ""

    @property
    def client(self) -> LlmClient:
        """Exposed so services (e.g. compaction) can issue side-channel calls
        with the same client without plumbing a second handle through."""
        return self._client

    @property
    def tools(self) -> ToolRegistry:
        """The registered tool set. Tests and diagnostics use this to inspect
        what's available on the live agent without reaching through privates."""
        return self._tools

    def set_tools(self, tools: ToolRegistry) -> None:
        """Swap the tool registry. Used by `build_agent` to register tools
        whose handlers need to read state owned by the loop (currently the
        active tool-call id, used by `ask_user`)."""
        self._tools = tools

    def current_tool_call_id(self) -> str:
        """The tool-call id of the in-flight dispatch, or empty when idle.
        Used by the `ask_user` tool to tag the staged Question so the
        placeholder tool-result can be matched and rewritten on answer."""
        return self._current_tool_call_id

    def current_conversation_id(self) -> str:
        """The conversation id of the in-flight turn, or empty when idle.
        Set by `run_turn`; `ask_user` reads it through the registered
        closure when staging a Question."""
        return self._current_conversation_id

    def run_turn(
        self,
        *,
        prefix: list[ChatMessage],
        history: list[ChatMessage],
        user_message: ChatMessage,
        on_delta: Callable[[StreamDelta], None] | None = None,
        on_message: Callable[[ChatMessage], None] | None = None,
        conversation_id: str = "",
    ) -> AgentTurn:
        self._current_conversation_id = conversation_id
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

            awaiting = False
            for idx, tc in enumerate(assistant_msg.tool_calls):
                if awaiting:
                    # Drop co-emitted tool calls after `ask_user` — the agent
                    # cannot make progress until the user answers.
                    _log.warning(
                        "ask_user_co_call_dropped",
                        tool_name=tc.name,
                        index=idx,
                    )
                    continue
                tool_result_msg = self._dispatch(tc)
                new_messages.append(tool_result_msg)
                working.append(tool_result_msg)
                if on_message:
                    on_message(tool_result_msg)
                if is_awaiting(tool_result_msg.content):
                    awaiting = True

            if awaiting:
                return AgentTurn(
                    final=assistant_msg,
                    new_messages=new_messages,
                    usage=total,
                    rounds=rounds,
                    awaiting_answer=True,
                )

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
        self._current_tool_call_id = tc.id
        try:
            content = self._tools.dispatch(tc.name, tc.arguments)
        finally:
            self._current_tool_call_id = ""
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
    role_raw = str(payload.get("role", "user"))
    role: ChatRole = role_raw if _is_chat_role(role_raw) else "user"
    tool_call_id = payload.get("tool_call_id")
    name = payload.get("name")
    return ChatMessage(
        role=role,
        content=str(payload.get("content") or ""),
        tool_calls=tool_calls,
        tool_call_id=tool_call_id if isinstance(tool_call_id, str) else None,
        name=name if isinstance(name, str) else None,
    )
