"""Agent assembly helper.

Both surfaces (HTTP `create_app` and the Textual app) need the same agent
wiring: fresh `ToolRegistry`, readonly tools bound to (conn, provider), and
— when writes are allowed — mutating tools bound to (conn, store,
active_item). Keep the shape in one place so the two entry points can't
drift."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

from docket.agent.llm_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.agent.mcp import MCPManager
from docket.agent.memory_tools import (
    register_memory_mutating_tools,
    register_memory_readonly_tools,
)
from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.source_tools import register_source_readonly_tools
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider


def build_agent(
    *,
    llm: LlmClient,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    store: ProposalStore,
    active_item: Callable[[], str | None],
    read_only: bool,
    provider_key: str = "",
    project_id: str = "",
    mcp_manager: MCPManager | None = None,
) -> AgentLoop:
    """Assemble an `AgentLoop` with the standard tool registry.

    `provider_key` scopes cache reads (list/search) to the active provider
    so the agent doesn't reason over items that belong to a different
    backend configured in the same DB.

    `project_id` scopes per-project memory and sources tools. When empty
    (no project context yet), those tools are simply not registered, so
    the agent stays useful for tasks that don't need them.

    `mcp_manager` adds tools from any MCP servers configured for the
    active project. Stripped entirely in read-only mode — we can't
    inspect side-effects from arbitrary MCP tool descriptions, so the
    safe default is to hide them when writes are forbidden.

    Read-only mode keeps every readonly tool so the agent can still answer
    questions; it just strips every `propose_*` tool so the agent can't
    stage writes.

    Tool registration order is part of the prompt prefix cache key — keep
    it stable: provider RO → memory RO → sources RO → MCP → provider
    mutating → memory mutating."""
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=conn, provider=provider, provider_key=provider_key)
    if project_id:
        register_memory_readonly_tools(registry, conn=conn, project_id=project_id)
        register_source_readonly_tools(registry, conn=conn, project_id=project_id)
    if mcp_manager is not None and not read_only and project_id:
        mcp_manager.register_tools(registry)
    if not read_only:
        register_mutating_tools(
            registry,
            conn=conn,
            store=store,
            active_item=active_item,
            provider_key=provider_key,
        )
        if project_id:
            register_memory_mutating_tools(
                registry, conn=conn, store=store, project_id=project_id
            )
    return AgentLoop(client=llm, tools=registry)


__all__ = ["build_agent"]
