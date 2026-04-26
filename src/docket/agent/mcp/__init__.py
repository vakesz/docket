"""MCP (Model Context Protocol) integration for the agent.

Per-project MCP servers expose extra tools (file system access, custom
internal queries, etc.) under the `mcp__<server_name>__<tool_name>`
namespace. This package handles the async/sync bridge so the synchronous
`AgentLoop` can call into the async `mcp` SDK without contaminating the
host event loop (FastAPI, anyio test loops, etc.).
"""

from __future__ import annotations

from docket.agent.mcp.client import MCPClient
from docket.agent.mcp.manager import MCPManager, MCPServerStatus

__all__ = ["MCPClient", "MCPManager", "MCPServerStatus"]
