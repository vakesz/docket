"""Tiny FastMCP server used by MCP integration tests.

Exposes two tools:

- `echo(text)` returns the text verbatim. Used to verify the happy path
  (handshake, list_tools, call_tool, text rendering).
- `boom()` always raises. Used to verify that server-side errors come
  back as `isError=True` and surface as JSON `{"error": ...}` to the
  agent.

Run as: `python -m tests.fakes.mcp_server` (stdin/stdout transport).
"""

from __future__ import annotations

from mcp.server import FastMCP

server: FastMCP = FastMCP("docket-test")


@server.tool()
def echo(text: str) -> str:
    """Return the input text verbatim."""
    return text


@server.tool()
def boom() -> str:
    """Always raise — used to test error propagation."""
    raise RuntimeError("boom")


if __name__ == "__main__":
    server.run("stdio")
