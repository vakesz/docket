"""Sync facade over an async MCP stdio client.

The agent loop is synchronous and runs on whatever thread the caller
chose (FastAPI worker, Textual worker, CLI main). The official `mcp`
SDK is built on `anyio` and requires its async context managers
(`stdio_client`, `ClientSession`) to be entered and exited on the same
task — you cannot freely call `__aenter__` and `__aexit__` from
arbitrary threads.

To bridge the two worlds we own a dedicated daemon thread per server
that runs a private `asyncio` event loop. The supervisor coroutine
opens the stdio transport and session inside `async with`, signals
"ready", then awaits a shutdown event. Shutdown therefore unwinds the
context managers from the original task, which keeps anyio's cancel
scopes happy.

Tool calls are dispatched via `run_coroutine_threadsafe` and block the
caller until the server responds (or the per-call timeout expires).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent, Tool

from docket.config.models import MCPServerEntry

log = logging.getLogger(__name__)

# Per-tool-call timeout. The startup timeout (handshake + tools/list) is
# configurable per server entry; individual `tools/call` invocations get
# a generous fixed ceiling because some legitimate tools are slow.
_CALL_TIMEOUT_SECONDS = 60.0


class MCPClient:
    """Long-lived sync client for one stdio MCP server.

    Lifecycle:

      `start()` - spawns the background thread, opens the subprocess,
        runs the MCP handshake, fetches the tool catalog. Blocks until
        the server is ready or `startup_timeout_seconds` elapses. Raises
        on failure so the manager can fail-soft.

      `list_tools()` / `call_tool()` - synchronous. Safe to call from
        any thread once `start()` has returned.

      `close()` - signals the supervisor to exit and joins the thread.
        Idempotent; safe to call from any thread.
    """

    def __init__(self, name: str, entry: MCPServerEntry) -> None:
        self.name = name
        self._entry = entry
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._session: ClientSession | None = None
        self._tools: list[Tool] = []
        # Set on the background loop once the session is initialized and
        # tools are listed; awaited on the foreground thread by `start()`.
        self._ready: threading.Event = threading.Event()
        self._startup_error: BaseException | None = None
        # Set on the foreground thread by `close()`; awaited on the
        # background loop by the supervisor coroutine.
        self._shutdown: asyncio.Event | None = None
        self._closed = False

    # ------------------------------------------------------------------ start
    def start(self) -> None:
        """Spawn the subprocess and complete the MCP handshake."""
        if self._thread is not None:
            raise RuntimeError(f"MCPClient '{self.name}' already started")
        self._thread = threading.Thread(
            target=self._thread_main,
            name=f"mcp-{self.name}",
            daemon=True,
        )
        self._thread.start()
        timeout = max(self._entry.startup_timeout_seconds, 0.1)
        if not self._ready.wait(timeout=timeout):
            self.close()
            raise TimeoutError(
                f"MCP server '{self.name}' did not become ready within {timeout:.1f}s"
            )
        if self._startup_error is not None:
            err = self._startup_error
            self.close()
            raise RuntimeError(f"MCP server '{self.name}' failed to start: {err}") from err

    def _thread_main(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        try:
            loop.run_until_complete(self._supervise())
        except BaseException as exc:
            # Anything that escaped the supervisor is a fatal startup or
            # shutdown error. Surface it to the foreground thread if
            # `start()` is still waiting on `_ready`.
            self._startup_error = exc
            self._ready.set()
        finally:
            try:
                loop.close()
            except Exception:  # pragma: no cover — best-effort cleanup
                log.debug("mcp.%s: loop.close() raised", self.name, exc_info=True)

    async def _supervise(self) -> None:
        """Hold the stdio + session contexts open until shutdown is signalled."""
        self._shutdown = asyncio.Event()
        params = StdioServerParameters(
            command=self._entry.command,
            args=list(self._entry.args),
            env=dict(self._entry.env) or None,
        )
        try:
            async with (
                stdio_client(params) as (read, write),
                ClientSession(read, write) as session,
            ):
                await session.initialize()
                listed = await session.list_tools()
                self._tools = list(listed.tools)
                self._session = session
                self._ready.set()
                # Park here until close() flips the event. All tool
                # calls run as separate tasks scheduled onto this
                # loop via run_coroutine_threadsafe; they share this
                # session because it lives in this task's scope.
                await self._shutdown.wait()
        except BaseException as exc:
            # Signal startup failure if we never got to `_ready.set()`.
            if not self._ready.is_set():
                self._startup_error = exc
                self._ready.set()
            raise
        finally:
            self._session = None

    # ------------------------------------------------------------- public API
    def list_tools(self) -> list[Tool]:
        """Return the cached tool catalog. Empty until `start()` succeeds."""
        return list(self._tools)

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Invoke `tool_name` and return its result as a string.

        Text content blocks are concatenated. Non-text content is
        rendered as a JSON placeholder so the model still sees something
        deterministic. Server-reported errors (`isError=True`) come back
        as a JSON `{"error": ...}` string the agent loop can inspect.
        """
        if self._session is None or self._loop is None or self._closed:
            return json.dumps({"error": f"MCP server '{self.name}' is not connected"})
        coro = self._call_tool_async(tool_name, arguments)
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return future.result(timeout=_CALL_TIMEOUT_SECONDS)
        except TimeoutError:
            future.cancel()
            return json.dumps(
                {
                    "error": f"MCP tool '{tool_name}' on '{self.name}' "
                    f"timed out after {_CALL_TIMEOUT_SECONDS:.0f}s"
                }
            )
        except Exception as exc:
            return json.dumps({"error": f"MCP tool '{tool_name}' failed: {exc}"})

    async def _call_tool_async(self, tool_name: str, arguments: dict[str, Any]) -> str:
        # `_session` is checked in the sync wrapper; reassert here for type
        # narrowing since we're hopping threads.
        assert self._session is not None
        result = await self._session.call_tool(tool_name, arguments)
        rendered_parts: list[str] = []
        for block in result.content:
            if isinstance(block, TextContent):
                rendered_parts.append(block.text)
            else:
                # ImageContent, EmbeddedResource, etc. — the agent
                # doesn't have a vision pipeline yet, so flatten to JSON.
                rendered_parts.append(json.dumps({"non_text_content": block.type}))
        rendered = "\n".join(rendered_parts) if rendered_parts else ""
        if result.isError:
            return json.dumps({"error": rendered or "MCP tool reported error"})
        return rendered

    def close(self) -> None:
        """Tear down the background loop and subprocess. Idempotent."""
        if self._closed:
            return
        self._closed = True
        loop = self._loop
        shutdown = self._shutdown
        if loop is not None and shutdown is not None and not loop.is_closed():
            loop.call_soon_threadsafe(shutdown.set)
        if self._thread is not None:
            self._thread.join(timeout=5.0)
            if self._thread.is_alive():  # pragma: no cover — defensive
                log.warning("mcp.%s: background thread did not exit", self.name)
        self._thread = None
        self._loop = None


__all__ = ["MCPClient"]
