"""End-to-end tests for the MCP stdio client + manager.

These tests spawn a real Python subprocess running the fake MCP server
under `tests/fakes/mcp_server.py`. That covers the whole stack:
StdioServerParameters → stdio_client → ClientSession → tools/list +
tools/call → text rendering. Faking the transport would only test the
sync/async bridge in isolation, which is the part most likely to be
correct by inspection — it's the cancel-scope and lifecycle interactions
that need real exercise.
"""

from __future__ import annotations

import json
import sqlite3
import sys

import pytest

from docket.agent.factory import build_agent
from docket.agent.mcp import MCPClient, MCPManager
from docket.agent.tools import ToolRegistry
from docket.config.models import MCPServerEntry
from docket.core.services.proposal_store import ProposalStore
from tests.fakes.llm import FakeLlmClient
from tests.fakes.provider import FakeProvider


def _server_entry(*, command: str | None = None, args: list[str] | None = None) -> MCPServerEntry:
    """Default `MCPServerEntry` pointing at our fake stdio server."""
    return MCPServerEntry(
        transport="stdio",
        command=command if command is not None else sys.executable,
        args=args if args is not None else ["-m", "tests.fakes.mcp_server"],
        startup_timeout_seconds=15.0,
    )


# -------------------------------------------------------------- MCPClient


def test_mcp_client_lists_and_calls_tools() -> None:
    """Happy path: handshake completes, tools are discovered, calls return text."""
    client = MCPClient("test", _server_entry())
    client.start()
    try:
        tool_names = {t.name for t in client.list_tools()}
        assert {"echo", "boom"} <= tool_names
        assert client.call_tool("echo", {"text": "hello world"}) == "hello world"
    finally:
        client.close()


def test_mcp_client_call_after_close_returns_error() -> None:
    """Calls made after `close()` should report a clean error, not crash."""
    client = MCPClient("test", _server_entry())
    client.start()
    client.close()
    payload = json.loads(client.call_tool("echo", {"text": "x"}))
    assert "error" in payload
    assert "not connected" in payload["error"]


def test_mcp_client_server_error_returns_json_error() -> None:
    """`isError=True` results should surface as `{"error": ...}` strings."""
    client = MCPClient("test", _server_entry())
    client.start()
    try:
        result = client.call_tool("boom", {})
        payload = json.loads(result)
        assert "error" in payload
        assert "boom" in payload["error"]
    finally:
        client.close()


def test_mcp_client_unknown_command_fails_to_start() -> None:
    """A subprocess that immediately exits should raise instead of hanging."""
    entry = MCPServerEntry(
        transport="stdio",
        command=sys.executable,
        args=["-c", "import sys; sys.exit(1)"],
        startup_timeout_seconds=2.0,
    )
    client = MCPClient("broken", entry)
    with pytest.raises((RuntimeError, TimeoutError)):
        client.start()
    # `start()` is responsible for cleaning up on failure; close() must
    # be idempotent so calling it again is harmless.
    client.close()


def test_mcp_client_close_is_idempotent() -> None:
    client = MCPClient("test", _server_entry())
    client.start()
    client.close()
    client.close()  # must not raise


# -------------------------------------------------------------- MCPManager


def test_mcp_manager_registers_tools_with_qualified_names() -> None:
    """Each connected server's tools land in the registry as `mcp__<server>__<tool>`."""
    manager = MCPManager()
    try:
        manager.bind_project("p1", {"fake": _server_entry()})
        registry = ToolRegistry()
        manager.register_tools(registry)
        assert "mcp__fake__echo" in registry
        assert "mcp__fake__boom" in registry
    finally:
        manager.close_all()


def test_mcp_manager_skips_disabled_servers() -> None:
    """`enabled=False` keeps the entry in config but spawns nothing."""
    manager = MCPManager()
    disabled = _server_entry()
    disabled = MCPServerEntry(**{**disabled.model_dump(), "enabled": False})
    try:
        manager.bind_project("p1", {"fake": disabled})
        assert manager.clients == {}
    finally:
        manager.close_all()


def test_mcp_manager_fails_soft_on_broken_server() -> None:
    """A server that won't start is logged and skipped; siblings still register."""
    broken = MCPServerEntry(
        transport="stdio",
        command=sys.executable,
        args=["-c", "import sys; sys.exit(1)"],
        startup_timeout_seconds=2.0,
    )
    manager = MCPManager()
    try:
        # Order matters less than fail-soft semantics: the working server
        # must be present whether the broken one is bound first or last.
        manager.bind_project("p1", {"broken": broken, "fake": _server_entry()})
        assert "fake" in manager.clients
        assert "broken" not in manager.clients
        registry = ToolRegistry()
        manager.register_tools(registry)
        assert "mcp__fake__echo" in registry
    finally:
        manager.close_all()


def test_mcp_manager_skips_entry_without_command() -> None:
    """An entry with no `command` is a misconfiguration, not a crash."""
    manager = MCPManager()
    try:
        manager.bind_project("p1", {"oops": MCPServerEntry()})
        assert manager.clients == {}
    finally:
        manager.close_all()


def test_mcp_manager_skips_unsupported_transport() -> None:
    manager = MCPManager()
    try:
        manager.bind_project(
            "p1",
            {
                "oops": MCPServerEntry(
                    transport="sse",
                    command=sys.executable,
                    args=["-m", "tests.fakes.mcp_server"],
                )
            },
        )
        assert manager.clients == {}
    finally:
        manager.close_all()


def test_mcp_manager_bind_project_swap_closes_old_clients() -> None:
    """Switching projects tears down the previous fleet."""
    manager = MCPManager()
    try:
        manager.bind_project("p1", {"fake": _server_entry()})
        first = manager.clients["fake"]
        manager.bind_project("p2", {"fake": _server_entry()})
        # New client is a different object; the old one was closed.
        assert manager.clients["fake"] is not first
        # Calling on the closed client should report disconnected.
        payload = json.loads(first.call_tool("echo", {"text": "x"}))
        assert "error" in payload
    finally:
        manager.close_all()


def test_mcp_manager_bind_none_closes_all() -> None:
    manager = MCPManager()
    manager.bind_project("p1", {"fake": _server_entry()})
    assert manager.clients
    manager.bind_project(None, {})
    assert manager.clients == {}
    assert manager.active_project_id is None


# ------------------------------------------------ build_agent integration


def _registered_names(agent_loop: object) -> set[str]:
    """Pull tool names off the AgentLoop without depending on internals.

    `AgentLoop._tools` is a `ToolRegistry`; `schemas()` is part of the
    public interface used by the LLM client."""
    registry = agent_loop._tools  # type: ignore[attr-defined]
    return {schema.name for schema in registry.schemas()}


def _conn() -> sqlite3.Connection:
    """In-memory connection — `build_agent` only passes it to tool
    closures; the MCP path doesn't read or write the DB."""
    return sqlite3.connect(":memory:")


def test_build_agent_registers_mcp_tools_for_project() -> None:
    """When a project is active and writes are allowed, MCP tools appear."""
    manager = MCPManager()
    try:
        manager.bind_project("github:default", {"fake": _server_entry()})
        agent = build_agent(
            llm=FakeLlmClient(),
            conn=_conn(),
            provider=FakeProvider(),
            store=ProposalStore(),
            active_item=lambda: None,
            read_only=False,
            provider_key="github",
            project_id="github:default",
            mcp_manager=manager,
        )
        names = _registered_names(agent)
        assert "mcp__fake__echo" in names
        assert "mcp__fake__boom" in names
    finally:
        manager.close_all()


def test_build_agent_strips_mcp_tools_in_read_only() -> None:
    """Read-only mode hides every MCP tool — we can't classify side effects."""
    manager = MCPManager()
    try:
        manager.bind_project("github:default", {"fake": _server_entry()})
        agent = build_agent(
            llm=FakeLlmClient(),
            conn=_conn(),
            provider=FakeProvider(),
            store=ProposalStore(),
            active_item=lambda: None,
            read_only=True,
            provider_key="github",
            project_id="github:default",
            mcp_manager=manager,
        )
        names = _registered_names(agent)
        assert not any(n.startswith("mcp__") for n in names)
    finally:
        manager.close_all()


def test_build_agent_skips_mcp_when_no_project_id() -> None:
    """No active project → no per-project tools, MCP included."""
    manager = MCPManager()
    try:
        manager.bind_project("github:default", {"fake": _server_entry()})
        agent = build_agent(
            llm=FakeLlmClient(),
            conn=_conn(),
            provider=FakeProvider(),
            store=ProposalStore(),
            active_item=lambda: None,
            read_only=False,
            provider_key="github",
            project_id="",
            mcp_manager=manager,
        )
        names = _registered_names(agent)
        assert not any(n.startswith("mcp__") for n in names)
    finally:
        manager.close_all()
