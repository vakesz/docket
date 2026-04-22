"""Agent-side types. These are intentionally SDK-agnostic so a fake LLM
client can produce the same shapes as the real LLM client without
importing `openai`."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ChatRole = Literal["system", "user", "assistant", "tool"]


@dataclass
class ChatMessage:
    """Canonical message in an LLM conversation.

    `tool_call_id` is set on role='tool' results. `tool_calls` is set on
    role='assistant' messages that requested tools."""

    role: ChatRole
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None  # tool name on role='tool'


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class ToolSchema:
    """JSON Schema description of a tool the model may call."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema object for arguments


@dataclass
class Usage:
    tokens_in: int = 0
    tokens_out: int = 0
    cached_tokens_in: int = 0


@dataclass
class StreamDelta:
    """One chunk from a streaming completion."""

    text: str = ""
    tool_call_delta: ToolCallDelta | None = None
    finish_reason: str | None = None
    usage: Usage | None = None


@dataclass
class ToolCallDelta:
    index: int
    id: str | None = None
    name: str | None = None
    arguments_fragment: str = ""


@dataclass
class CompletionResult:
    """Final accumulated result of a (possibly streamed) completion."""

    message: ChatMessage
    usage: Usage
    finish_reason: str
