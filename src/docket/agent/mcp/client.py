"""Sync facade over an async MCP client (stdio, http, or sse).

The agent loop is synchronous and runs on whatever thread the caller
chose (FastAPI worker, Textual worker, CLI main). The official `mcp`
SDK is built on `anyio` and requires its async context managers
(`stdio_client`, `streamablehttp_client`, `sse_client`, `ClientSession`)
to be entered and exited on the same task — you cannot freely call
`__aenter__` and `__aexit__` from arbitrary threads.

To bridge the two worlds we own a dedicated daemon thread per server
that runs a private `asyncio` event loop. The supervisor coroutine
opens the transport + session inside `async with`, signals "ready", then
awaits a shutdown event. Shutdown therefore unwinds the context
managers from the original task, which keeps anyio's cancel scopes
happy.

Tool calls are dispatched via `run_coroutine_threadsafe` and block the
caller until the server responds (or the per-call timeout expires).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.sse import sse_client
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from mcp.types import TextContent, Tool

from docket.agent._helpers import arg_error
from docket.config.models import MCPServerEntry

log = logging.getLogger(__name__)

# Per-tool-call timeout. The startup timeout (handshake + tools/list) is
# configurable per server entry; individual `tools/call` invocations get
# a generous fixed ceiling because some legitimate tools are slow.
_CALL_TIMEOUT_SECONDS = 60.0


class MCPClient:
    """Long-lived sync client for one MCP server (stdio, http, or sse).

    Lifecycle:

      `start()` - spawns the background thread, opens the transport,
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
        # Observability: surfaced via the runtime status endpoint so the
        # SPA can show "fake — connected at 12:01:34, 5 tools" or the
        # last error string.
        self.started_at: datetime | None = None
        self.last_error: str | None = None

    # ------------------------------------------------------------------ start
    def start(self) -> None:
        """Open the transport and complete the MCP handshake."""
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
            self.last_error = f"timed out after {timeout:.1f}s"
            self.close()
            raise TimeoutError(
                f"MCP server '{self.name}' did not become ready within {timeout:.1f}s"
            )
        if self._startup_error is not None:
            err = self._startup_error
            self.last_error = str(err) or type(err).__name__
            self.close()
            raise RuntimeError(f"MCP server '{self.name}' failed to start: {err}") from err
        self.started_at = datetime.now(UTC)

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
        """Hold the transport + session contexts open until shutdown is signalled."""
        self._shutdown = asyncio.Event()
        # Bound the handshake so a misbehaving server can't hang the
        # supervisor forever. `close()` signals `_shutdown`, but that
        # only unblocks us once we're parked on `wait()` below — if the
        # server is wedged inside `initialize()` / `list_tools()`, the
        # shutdown event never gets a chance to fire.
        handshake_timeout = max(self._entry.startup_timeout_seconds, 0.1)
        transport = (self._entry.transport or "stdio").strip() or "stdio"
        try:
            if transport == "stdio":
                async with self._stdio_streams() as (read, write):
                    await self._run_session(read, write, handshake_timeout)
            elif transport == "http":
                async with self._http_streams() as (read, write):
                    await self._run_session(read, write, handshake_timeout)
            elif transport == "sse":
                async with self._sse_streams() as (read, write):
                    await self._run_session(read, write, handshake_timeout)
            else:
                # `mcp_service.validate_entry` filters this in normal flows;
                # explicit branch keeps the failure mode obvious if a
                # caller bypasses the service.
                raise ValueError(f"unsupported transport '{transport}'")
        except BaseException as exc:
            # Signal startup failure if we never got to `_ready.set()`.
            if not self._ready.is_set():
                self._startup_error = exc
                self._ready.set()
            raise
        finally:
            self._session = None

    @asynccontextmanager
    async def _stdio_streams(self) -> AsyncIterator[tuple[Any, Any]]:
        params = StdioServerParameters(
            command=self._entry.command,
            args=list(self._entry.args),
            env=dict(self._entry.env) or None,
        )
        async with stdio_client(params) as streams:
            yield streams

    @asynccontextmanager
    async def _http_streams(self) -> AsyncIterator[tuple[Any, Any]]:
        # `streamable_http_client` takes a pre-built `httpx.AsyncClient` (the
        # old `headers=` kwarg was dropped in MCP SDK 1.27). We own the
        # client's lifecycle — the SDK only enters its context when it built
        # one itself. Yields (read, write, get_session_id); we don't surface
        # the session id, so unpack the first two only.
        headers = dict(self._entry.headers) or None
        async with (
            httpx.AsyncClient(headers=headers) as client,
            streamable_http_client(self._entry.url, http_client=client) as (
                read,
                write,
                _get_session_id,
            ),
        ):
            yield (read, write)

    @asynccontextmanager
    async def _sse_streams(self) -> AsyncIterator[tuple[Any, Any]]:
        async with sse_client(
            self._entry.url,
            headers=dict(self._entry.headers) or None,
        ) as streams:
            yield streams

    async def _run_session(self, read: Any, write: Any, handshake_timeout: float) -> None:
        async with ClientSession(read, write) as session:
            async with asyncio.timeout(handshake_timeout):
                await session.initialize()
                listed = await session.list_tools()
            self._tools = list(listed.tools)
            self._session = session
            self._ready.set()
            # Park here until close() flips the event. All tool calls
            # run as separate tasks scheduled onto this loop via
            # run_coroutine_threadsafe; they share this session because
            # it lives in this task's scope.
            assert self._shutdown is not None
            await self._shutdown.wait()

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
            return arg_error(f"MCP server '{self.name}' is not connected")
        coro = self._call_tool_async(tool_name, arguments)
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        started = time.monotonic_ns()
        try:
            return future.result(timeout=_CALL_TIMEOUT_SECONDS)
        except TimeoutError:
            future.cancel()
            self.last_error = f"tool '{tool_name}' timed out"
            return arg_error(
                f"MCP tool '{tool_name}' on '{self.name}' "
                f"timed out after {_CALL_TIMEOUT_SECONDS:.0f}s"
            )
        except Exception as exc:
            self.last_error = f"tool '{tool_name}' failed: {exc}"
            return arg_error(f"MCP tool '{tool_name}' failed: {exc}")
        finally:
            log.debug(
                "mcp.%s call_tool=%s latency_ms=%.1f",
                self.name,
                tool_name,
                (time.monotonic_ns() - started) / 1e6,
            )

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
            return arg_error(rendered or "MCP tool reported error")
        return rendered

    def close(self) -> None:
        """Tear down the background loop and transport. Idempotent."""
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
