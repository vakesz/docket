"""Sanity coverage for the structured-log emissions added for observability.

The agent's ToolRegistry, MCP fleet binding, and mutation_service all emit
canonical events (`tool_call`, `mcp_bind`, `proposal_confirm`) with a fixed
vocabulary (`outcome`, `latency_ms`, `error_type`). We poke the chokepoints
through their normal code paths and assert the events land on the stdlib
log stream — that's what the on-disk JSON file picks up."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from pathlib import Path

import pytest

from docket.agent.tools import ToolRegistry
from docket.config.paths import Paths
from docket.telemetry.logging import _DOCKET_HANDLER_ATTR, init_logging


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    p = Paths(
        config_dir=tmp_path / "config",
        state_dir=tmp_path / "state",
        cache_dir=tmp_path / "cache",
    )
    p.ensure()
    return p


@pytest.fixture(autouse=True)
def _wire_logging(paths: Paths) -> Iterator[None]:
    """Configure structlog → stdlib so caplog sees the JSON-rendered payload."""
    init_logging(paths)
    yield
    # Tear down our own handler so the next test gets a clean root.
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _DOCKET_HANDLER_ATTR, False):
            root.removeHandler(h)


def _records_for(caplog: pytest.LogCaptureFixture, event: str) -> list[dict[str, object]]:
    matches: list[dict[str, object]] = []
    for record in caplog.records:
        try:
            payload = json.loads(record.getMessage())
        except (ValueError, TypeError):
            continue
        if payload.get("event") == event:
            matches.append(payload)
    return matches


def test_tool_call_ok_emits_structured_event(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="docket.agent.tools")
    registry = ToolRegistry()
    registry.register("noop", "no-op", {"type": "object"}, lambda _args: "done")

    out = registry.dispatch("noop", {})

    assert out == "done"
    events = _records_for(caplog, "tool_call")
    assert len(events) == 1
    payload = events[0]
    assert payload["tool_name"] == "noop"
    assert payload["outcome"] == "ok"
    assert isinstance(payload["latency_ms"], int)


def test_tool_call_error_emits_error_type(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="docket.agent.tools")
    registry = ToolRegistry()

    def _boom(_args: dict[str, object]) -> str:
        raise RuntimeError("kaboom")

    registry.register("boom", "raises", {"type": "object"}, _boom)

    out = registry.dispatch("boom", {})

    assert "kaboom" in out
    events = _records_for(caplog, "tool_call")
    assert len(events) == 1
    payload = events[0]
    assert payload["tool_name"] == "boom"
    assert payload["outcome"] == "error"
    assert payload["error_type"] == "RuntimeError"


def test_tool_call_unknown_tool_emits_warning_event(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG, logger="docket.agent.tools")
    registry = ToolRegistry()
    registry.dispatch("ghost", {})
    events = _records_for(caplog, "tool_call")
    assert len(events) == 1
    assert events[0]["outcome"] == "unknown_tool"
    assert events[0]["tool_name"] == "ghost"
