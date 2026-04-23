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

import json
import logging
import time
from typing import Any

from docket.agent.mcp.client import MCPClient
from docket.agent.tools import ToolHandler, ToolRegistry
from docket.config.models import MCPServerEntry
from docket.core.services import mcp_service
from docket.telemetry.logging import get_logger

log = logging.getLogger(__name__)
_event_log = get_logger(__name__)


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

    @property
    def active_project_id(self) -> str | None:
        return self._project_id

    @property
    def clients(self) -> dict[str, MCPClient]:
        """Snapshot of currently-connected clients keyed by server name."""
        return dict(self._clients)

    def bind_project(self, project_id: str | None, servers: dict[str, MCPServerEntry]) -> None:
        """Switch to `project_id`'s MCP fleet.

        Tears down any previously-connected clients first, then starts
        every enabled server in `servers`. Servers that fail to start
        are logged and skipped — the manager does not raise. Pass
        `project_id=None` (or an empty `servers` dict) to simply close
        everything, e.g. on shutdown or when no project is active.
        """
        self.close_all()
        self._project_id = project_id
        if not project_id:
            return
        for name, entry in servers.items():
            try:
                entry = mcp_service.validate_entry(entry)
            except mcp_service.InvalidServerConfigError as exc:
                log.warning("mcp.%s: invalid config (%s); skipping", name, exc)
                _event_log.warning(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="error",
                    error_type="invalid_config",
                )
                continue
            if not entry.enabled:
                _event_log.debug(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="disabled",
                )
                continue
            if not entry.command:
                log.warning(
                    "mcp.%s: skipping — entry has no `command` configured",
                    name,
                )
                _event_log.warning(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="error",
                    error_type="missing_command",
                )
                continue
            client = MCPClient(name, entry)
            started = time.monotonic_ns()
            try:
                client.start()
            except Exception as exc:
                latency_ms = (time.monotonic_ns() - started) // 1_000_000
                log.warning(
                    "mcp.%s: failed to start (%s); skipping. command=%r args=%r",
                    name,
                    exc,
                    entry.command,
                    list(entry.args),
                )
                _event_log.warning(
                    "mcp_bind",
                    project=project_id,
                    tool_name=name,
                    outcome="error",
                    error_type=type(exc).__name__,
                    latency_ms=latency_ms,
                )
                # `start()` already calls `close()` on failure, but be
                # defensive in case a future code path changes that.
                client.close()
                continue
            self._clients[name] = client
            tool_count = len(client.list_tools())
            log.info(
                "mcp.%s: connected (%d tool%s)",
                name,
                tool_count,
                "" if tool_count == 1 else "s",
            )
            _event_log.info(
                "mcp_bind",
                project=project_id,
                tool_name=name,
                outcome="ok",
                latency_ms=(time.monotonic_ns() - started) // 1_000_000,
                tools=tool_count,
            )

    def register_tools(self, registry: ToolRegistry) -> None:
        """Expose every connected server's tools to `registry`.

        Each tool is registered as `mcp__<server>__<tool>`. Order is
        deterministic (sorted by server name, then tool name) so the
        prompt prefix stays cache-stable across runs as long as the
        config doesn't change.
        """
        for server_name in sorted(self._clients):
            client = self._clients[server_name]
            tools = sorted(client.list_tools(), key=lambda t: t.name)
            for tool in tools:
                qualified = f"mcp__{server_name}__{tool.name}"
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
                log.debug("mcp.%s: close raised", name, exc_info=True)
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
            return json.dumps({"error": f"MCP call failed: {exc}"})

    return handler


__all__ = ["MCPManager"]
