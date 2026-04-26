"""LLM client.

Concrete impl targets Azure OpenAI (OpenAI-compatible endpoints), wrapped
behind a narrow `LlmClient` Protocol so the agent loop and tests can work
against a structural interface rather than raw openai types.

Prompt caching: OpenAI-compatible endpoints cache based on exact prefix
match. The agent builds messages with the stable prefix (system + tools +
item snapshot) at the front so repeated turns on the same ticket get
cached. No explicit cache flag is needed; the service hashes the prefix
automatically. What matters is that message ordering and tool schema stay
deterministic between calls.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterable, Iterator
from typing import Any, Protocol
from urllib.parse import parse_qs, urlparse

from docket.agent.types import (
    ChatMessage,
    CompletionResult,
    StreamDelta,
    ToolCall,
    ToolCallDelta,
    ToolSchema,
    Usage,
)

DEFAULT_AZURE_API_VERSION = "2025-01-01-preview"


class LlmClient(Protocol):
    """Structural interface every LLM client must satisfy.

    The agent depends on this Protocol, not on the concrete client, so
    tests can substitute a scripted fake. Non-streaming consumers wrap
    `stream(...)` with `accumulate_stream(...)` — there's a single
    happy path through the SDK so streaming and non-streaming usage
    can't drift."""

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolSchema],
        *,
        temperature: float | None = None,
    ) -> Iterator[StreamDelta]: ...


class AzureOpenAIClient:
    """Azure OpenAI client satisfying the `LlmClient` protocol.

    We accept either the bare resource URL the portal shows
    (`https://<resource>.cognitiveservices.azure.com/`) or the full deployment
    URL the deployment blade offers as the default sample
    (`…/openai/deployments/<name>/chat/completions?api-version=…`). In the latter
    case we parse the deployment name and api-version out so users don't have to
    carry three env vars."""

    def __init__(
        self,
        *,
        endpoint: str,
        api_key: str,
        deployment: str | None = None,
        api_version: str | None = None,
    ) -> None:
        # Late import — the SDK is optional at import time so callers that only
        # touch types/tests don't force an openai install path.
        from openai import AzureOpenAI

        base, deployment_from_url, api_version_from_url = _parse_azure_endpoint(endpoint)
        resolved_deployment = deployment or deployment_from_url
        if not resolved_deployment:
            raise ValueError(
                "Azure OpenAI deployment is required — set llm.deployment in "
                "config.toml or use a full deployment URL for llm.endpoint."
            )
        self._deployment = resolved_deployment
        self._client = AzureOpenAI(
            azure_endpoint=base,
            api_key=api_key,
            api_version=api_version or api_version_from_url or DEFAULT_AZURE_API_VERSION,
        )

    # -- public API ---------------------------------------------------------

    def stream(
        self,
        messages: list[ChatMessage],
        tools: list[ToolSchema],
        *,
        temperature: float | None = None,
    ) -> Iterator[StreamDelta]:
        kwargs: dict[str, Any] = {
            "model": self._deployment,
            "messages": [_to_openai_message(m) for m in messages],
            "tools": [_to_openai_tool(t) for t in tools] or None,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        stream = self._client.chat.completions.create(**kwargs)
        for chunk in stream:
            yield _from_openai_chunk(chunk)


# -- helpers ----------------------------------------------------------------


_DEPLOYMENT_PATH_RE = re.compile(r"/openai/deployments/(?P<name>[^/?#]+)", re.IGNORECASE)


def _parse_azure_endpoint(endpoint: str) -> tuple[str, str | None, str | None]:
    """Split a user-supplied endpoint into (resource_base, deployment, api_version).

    Accepts the bare resource URL or a full deployment URL. Returns the scheme+host
    as `resource_base` (trailing slash stripped) so `AzureOpenAI` can build the
    deployment path itself — passing a URL that already contains `/openai/…` makes
    the SDK double-path the request and produce a 404."""
    parsed = urlparse(endpoint.strip())
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f"llm.endpoint is not a valid URL: {endpoint!r}")
    base = f"{parsed.scheme}://{parsed.netloc}"
    match = _DEPLOYMENT_PATH_RE.search(parsed.path or "")
    deployment = match.group("name") if match else None
    query = parse_qs(parsed.query or "")
    api_version_values = query.get("api-version") or []
    api_version = api_version_values[0] if api_version_values else None
    return base, deployment, api_version


def _to_openai_message(m: ChatMessage) -> dict[str, Any]:
    out: dict[str, Any] = {"role": m.role}
    if m.content:
        out["content"] = m.content
    if m.tool_calls:
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)},
            }
            for tc in m.tool_calls
        ]
    if m.tool_call_id:
        out["tool_call_id"] = m.tool_call_id
    if m.name:
        out["name"] = m.name
    return out


def _to_openai_tool(t: ToolSchema) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        },
    }


def _from_openai_usage(u: Any) -> Usage:
    if u is None:
        return Usage()
    cached = 0
    details = getattr(u, "prompt_tokens_details", None)
    if details is not None:
        cached = getattr(details, "cached_tokens", 0) or 0
    return Usage(
        tokens_in=u.prompt_tokens or 0,
        tokens_out=u.completion_tokens or 0,
        cached_tokens_in=cached,
    )


def _from_openai_chunk(chunk: Any) -> StreamDelta:
    delta = StreamDelta()
    choices = chunk.choices or []
    if choices:
        c = choices[0]
        d = c.delta
        if d.content:
            delta.text = d.content
        tool_calls = d.tool_calls or []
        if tool_calls:
            tc = tool_calls[0]
            delta.tool_call_delta = ToolCallDelta(
                index=tc.index,
                id=getattr(tc, "id", None),
                name=getattr(tc.function, "name", None) if tc.function else None,
                arguments_fragment=(tc.function.arguments or "") if tc.function else "",
            )
        if c.finish_reason:
            delta.finish_reason = c.finish_reason
    if chunk.usage:
        delta.usage = _from_openai_usage(chunk.usage)
    return delta


def accumulate_stream(stream: Iterable[StreamDelta]) -> CompletionResult:
    """Consume a stream into a final CompletionResult. Used by non-streaming
    paths (tests, headless API) and mirrors what the TUI does incrementally."""
    text_parts: list[str] = []
    tool_calls_by_index: dict[int, dict[str, Any]] = {}
    usage = Usage()
    finish_reason = "stop"
    for delta in stream:
        if delta.text:
            text_parts.append(delta.text)
        if delta.tool_call_delta:
            tcd = delta.tool_call_delta
            slot = tool_calls_by_index.setdefault(
                tcd.index, {"id": None, "name": None, "arguments": ""}
            )
            if tcd.id:
                slot["id"] = tcd.id
            if tcd.name:
                slot["name"] = tcd.name
            if tcd.arguments_fragment:
                slot["arguments"] += tcd.arguments_fragment
        if delta.usage:
            usage = delta.usage
        if delta.finish_reason:
            finish_reason = delta.finish_reason
    tool_calls: list[ToolCall] = []
    for idx in sorted(tool_calls_by_index):
        slot = tool_calls_by_index[idx]
        try:
            args = json.loads(slot["arguments"] or "{}")
        except json.JSONDecodeError:
            args = {}
        tool_calls.append(
            ToolCall(
                id=slot["id"] or f"call_{idx}",
                name=slot["name"] or "",
                arguments=args,
            )
        )
    message = ChatMessage(
        role="assistant",
        content="".join(text_parts),
        tool_calls=tool_calls,
    )
    return CompletionResult(message=message, usage=usage, finish_reason=finish_reason)


__all__ = [
    "AzureOpenAIClient",
    "ChatMessage",
    "CompletionResult",
    "LlmClient",
    "StreamDelta",
    "ToolCall",
    "ToolSchema",
    "Usage",
    "accumulate_stream",
]
