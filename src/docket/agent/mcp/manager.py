"""Per-project lifecycle manager for MCP clients.

Owned by the runtime (HTTP `app.state` / TUI context). On project switch
we tear down the previous project's clients and lazily start the new
project's enabled servers. Agent rebuilds call `register_tools()` to
expose every connected server's tools to the freshly-built
`ToolRegistry`.

Failure policy: a server that won't start, won't initialize, or won't
list its tools is logged as a warning and silently skipped. The agent
keeps working with the remaining servers — MCP is opt-in extra power,
not a critical dependency.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from docket.agent._helpers import arg_error
from docket.agent.mcp.client import MCPClient
from docket.agent.tools import ToolHandler, ToolRegistry
from docket.config.models import MCPServerEntry
from docket.core.services import mcp_service
from docket.telemetry.logging import elapsed_ms, get_logger

_log = get_logger(__name__)


@dataclass(frozen=True)
class MCPServerStatus:
    """Snapshot of one server in the live fleet.

    `connected` reports whether `MCPManager` currently holds a started
    `MCPClient` for this name. `tools` is the discovered catalog (qualified
    `mcp__<name>__<tool>` form so callers can correlate with the agent's
    registry). `last_error` carries the most recent failure surfaced by the
    client, including handshake/timeout failures when the server failed to
    start at all."""

    name: str
    transport: str
    connected: bool
    tools: list[str]
    started_at: datetime | None
    last_error: str | None


class MCPManager:
    """Holds the active project's MCP clients.

    Thread-safety: the manager is mutated from the main thread (TUI /
    HTTP startup, scope-switch handlers). Tool dispatch reads
    `_clients` from worker threads but only via closures captured at
    registration time, so there's no concurrent map mutation in the hot
    path.
    """

    def __init__(self) -> None:
        self._clients: dict[str, MCPClient] = {}
        self._project_id: str | None = None
        # Per-server failure trace from the last `bind_project`. Cleared
        # on each new bind so stale entries from a previous project don't
        # leak into the runtime status.
        self._bind_errors: dict[str, str] = {}
        # Transport recorded at bind time so the status endpoint can
        # render "fake (stdio)" without re-reading config. Mirrors
        # `_clients` for connected servers and survives in `_bind_errors`
        # for those that failed.
        self._transports: dict[str, str] = {}

    @property
    def active_project_id(self) -> str | None:
        return self._project_id

    @property
    def clients(self) -> dict[str, MCPClient]:
        """Snapshot of currently-connected clients keyed by server name."""
        return dict(self._clients)

    def status(self) -> list[MCPServerStatus]:
        """Per-server snapshot of the live fleet for the active project.

        Includes both connected clients and entries that failed to start
        on the last bind, sorted by name so the UI render order is stable."""
        names = sorted(set(self._clients) | set(self._bind_errors))
        out: list[MCPServerStatus] = []
        for name in names:
            client = self._clients.get(name)
            transport = self._transports.get(name, "stdio")
            if client is not None:
                tools = sorted(f"mcp__{name}__{t.name}" for t in client.list_tools())
                out.append(
                    MCPServerStatus(
                        name=name,
                        transport=transport,
                        connected=True,
                        tools=tools,
                        started_at=client.started_at,
                        last_error=client.last_error,
                    )
                )
            else:
                out.append(
                    MCPServerStatus(
                        name=name,
                        transport=transport,
                        connected=False,
                        tools=[],
                        started_at=None,
                        last_error=self._bind_errors.get(name),
                    )
                )
        return out

    def bind_project(self, project_id: str | None, servers: dict[str, MCPServerEntry]) -> None:
        """Switch to `project_id`'s MCP fleet.

        Tears down any previously-connected clients first, then starts
        every enabled server in `servers`. Servers that fail to start
        are logged, recorded in `status()`, and skipped — the manager
        does not raise. Pass `project_id=None` (or an empty `servers`
        dict) to simply close everything, e.g. on shutdown or when no
        project is active.
        """
        self.close_all()
        self._bind_errors.clear()
        self._transports.clear()
        self._project_id = project_id
        if not project_id:
            return
        for name, entry in servers.items():
            self._transports[name] = (entry.transport or "stdio").strip() or "stdio"
            try:
                entry = mcp_service.validate_entry(entry)
            except mcp_service.InvalidServerConfigError as exc:
                _log.warning(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="error",
                    error_type="invalid_config",
                    reason=str(exc),
                )
                self._bind_errors[name] = str(exc)
                continue
            if not entry.enabled:
                _log.debug(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="disabled",
                )
                # Disabled isn't an error — drop from the failure trace
                # too so it doesn't show up in `status()` as "failed".
                self._transports.pop(name, None)
                continue
            client = MCPClient(name, entry)
            started = time.monotonic_ns()
            try:
                client.start()
            except Exception as exc:
                _log.warning(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="error",
                    error_type=type(exc).__name__,
                    reason=str(exc),
                    transport=entry.transport,
                    latency_ms=elapsed_ms(started),
                )
                # `start()` already calls `close()` on failure, but be
                # defensive in case a future code path changes that.
                client.close()
                self._bind_errors[name] = str(exc) or type(exc).__name__
                continue
            self._clients[name] = client
            tool_count = len(client.list_tools())
            _log.info(
                "mcp_bind",
                project=project_id,
                tool_name=name,
                outcome="ok",
                latency_ms=elapsed_ms(started),
                tools=tool_count,
            )

    def register_tools(self, registry: ToolRegistry) -> None:
        """Expose every connected server's tools to `registry`.

        Each tool is registered as `mcp__<server>__<tool>`. Order is
        deterministic (sorted by server name, then tool name) so the
        prompt prefix stays cache-stable across runs as long as the
        config doesn't change.
        """
        # Track qualified names we've already registered so we can warn
        # when two servers advertise tools that collide on the fully
        # qualified `mcp__<server>__<tool>` form. `ToolRegistry.register`
        # silently overwrites duplicates, so without this warning a
        # collision would be invisible until someone notices a tool
        # calling the wrong handler.
        seen: dict[str, str] = {}
        for server_name in sorted(self._clients):
            client = self._clients[server_name]
            tools = sorted(client.list_tools(), key=lambda t: t.name)
            for tool in tools:
                qualified = f"mcp__{server_name}__{tool.name}"
                if qualified in seen:
                    _log.warning(
                        "mcp_tool_collision",
                        tool_name=qualified,
                        previous=seen[qualified],
                        winner=server_name,
                    )
                seen[qualified] = server_name
                description = tool.description or f"MCP tool from {server_name}"
                # MCP `inputSchema` is always a JSON Schema object; the
                # agent's tool schema layer expects a dict in the same
                # shape, so pass it through directly.
                parameters: dict[str, Any] = (
                    dict(tool.inputSchema)
                    if tool.inputSchema
                    else {"type": "object", "properties": {}}
                )
                registry.register(
                    qualified,
                    description,
                    parameters,
                    _make_handler(client, tool.name),
                )

    def close_all(self) -> None:
        """Stop every connected client. Idempotent; safe on shutdown."""
        for name, client in list(self._clients.items()):
            try:
                client.close()
            except Exception:
                _log.debug("mcp_close_raised", tool_name=name, exc_info=True)
        self._clients.clear()


def _make_handler(client: MCPClient, tool_name: str) -> ToolHandler:
    """Build a sync `ToolHandler` closure for one MCP tool.

    Extracted to a module-level factory so each closure captures only
    the small `(client, tool_name)` pair instead of the whole manager.
    """

    def handler(arguments: dict[str, Any]) -> str:
        try:
            return client.call_tool(tool_name, arguments)
        except Exception as exc:
            return arg_error(f"MCP call failed: {exc}")

    return handler


__all__ = ["MCPManager", "MCPServerStatus"]
