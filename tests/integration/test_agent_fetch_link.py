"""Contract tests for the `fetch_link` agent tool.

Exercises the happy path (HTML → Markdown round-trip with httpx patched),
scheme rejection, byte cap, and transport-error soft-failure."""

from __future__ import annotations

import json

import httpx
import pytest

from docket.agent.link_tools import register_link_tools
from docket.agent.tools import ToolRegistry


@pytest.fixture
def registry() -> ToolRegistry:
    r = ToolRegistry()
    register_link_tools(r)
    return r


def _mock_transport(response: httpx.Response) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return response

    return httpx.MockTransport(handler)


def test_fetch_link_requires_url(registry: ToolRegistry) -> None:
    out = json.loads(registry.dispatch("fetch_link", {}))
    assert "url is required" in out["error"]


def test_fetch_link_rejects_non_http_scheme(registry: ToolRegistry) -> None:
    out = json.loads(registry.dispatch("fetch_link", {"url": "file:///etc/passwd"}))
    assert "http/https" in out["error"]


def test_fetch_link_rejects_url_without_host(registry: ToolRegistry) -> None:
    out = json.loads(registry.dispatch("fetch_link", {"url": "http://"}))
    assert "host" in out["error"]


def test_fetch_link_converts_html_to_markdown(
    registry: ToolRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    html = "<html><head><title>Docs</title></head><body><h1>Hi</h1><p>Body text.</p></body></html>"
    response = httpx.Response(
        200,
        content=html.encode("utf-8"),
        headers={"content-type": "text/html; charset=utf-8"},
    )

    original_client = httpx.Client

    class _PatchedClient(original_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = _mock_transport(response)
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("docket.agent.link_tools.httpx.Client", _PatchedClient)

    out = json.loads(registry.dispatch("fetch_link", {"url": "https://example.test/doc"}))
    assert out["status_code"] == 200
    assert out["content_type"] == "text/html"
    assert "Hi" in out["body_md"]
    assert "Body text." in out["body_md"]
    assert out["truncated"] is False


def test_fetch_link_transport_error_returns_soft_error(
    registry: ToolRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    def _raise(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom")

    original_client = httpx.Client

    class _PatchedClient(original_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = httpx.MockTransport(_raise)
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("docket.agent.link_tools.httpx.Client", _PatchedClient)

    out = json.loads(registry.dispatch("fetch_link", {"url": "https://unreachable.test"}))
    assert "fetch failed" in out["error"]


def test_fetch_link_truncates_large_body(
    registry: ToolRegistry, monkeypatch: pytest.MonkeyPatch
) -> None:
    big = "a" * (300 * 1024)
    response = httpx.Response(
        200,
        content=big.encode("utf-8"),
        headers={"content-type": "text/plain"},
    )

    original_client = httpx.Client

    class _PatchedClient(original_client):  # type: ignore[misc, valid-type]
        def __init__(self, *args: object, **kwargs: object) -> None:
            kwargs["transport"] = _mock_transport(response)
            super().__init__(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr("docket.agent.link_tools.httpx.Client", _PatchedClient)

    out = json.loads(registry.dispatch("fetch_link", {"url": "https://example.test/big"}))
    assert out["truncated"] is True
    # Byte cap (256 KB) comes first, then char cap; either way result is bounded.
    assert len(out["body_md"]) <= 32_000
