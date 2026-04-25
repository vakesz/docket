"""Agent assembly helper.

Both surfaces (HTTP `create_app` and the Textual app) need the same agent
wiring: fresh `ToolRegistry`, readonly tools bound to (conn, provider), and
— when writes are allowed — mutating tools bound to (conn, store,
active_item). Keep the shape in one place so the two entry points can't
drift."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

from docket.agent._commit_tools import register_commit_tools
from docket.agent._item_tools import register_item_tools
from docket.agent._pr_tools import register_pr_tools
from docket.agent.link_tools import register_link_tools
from docket.agent.llm_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.agent.mcp import MCPManager
from docket.agent.memory_tools import (
    register_memory_mutating_tools,
    register_memory_readonly_tools,
)
from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.question_tool import register_ask_user_tool
from docket.agent.source_tools import register_source_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.question_store import QuestionStore
from docket.providers.base import WorkItemProvider


def register_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    provider_key: str = "",
) -> None:
    """Register the full read-only tool surface on `registry`.

    Registration order (load-bearing): item tools → PR tools → commit/CI
    tools. The PR and commit groups are provider-gated; each tool is
    registered only if the provider backs it. Reorder at the cost of every
    open conversation's cached prompt prefix."""
    register_item_tools(registry, conn=conn, provider=provider, provider_key=provider_key)
    register_pr_tools(registry, provider=provider)
    register_commit_tools(registry, provider=provider)


def build_tool_registry(
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    store: ProposalStore,
    active_item: Callable[[], str | None],
    read_only: bool,
    provider_key: str = "",
    project_id: str = "",
    mcp_manager: MCPManager | None = None,
    question_store: QuestionStore | None = None,
    conversation_id: Callable[[], str] | None = None,
    current_tool_call_id: Callable[[], str] | None = None,
) -> ToolRegistry:
    """Assemble the standard `ToolRegistry`.

    Separated from `build_agent` so tests can lock the registration order
    (which is part of the prompt prefix cache key) without having to supply
    an LLM client. See `tests/unit/test_tool_registration_order.py` for the
    pinned sequence.

    Registration order (load-bearing): provider RO → link RO → memory RO →
    sources RO → MCP → provider mutating → memory mutating → ask_user.
    Changing it invalidates every open conversation's prompt cache.

    `ask_user` is appended last and is registered regardless of read_only —
    it does not mutate provider state."""
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=conn, provider=provider, provider_key=provider_key)
    register_link_tools(registry)
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
            provider=provider,
            provider_key=provider_key,
        )
        if project_id:
            register_memory_mutating_tools(registry, conn=conn, store=store, project_id=project_id)
    if (
        question_store is not None
        and conversation_id is not None
        and current_tool_call_id is not None
    ):
        register_ask_user_tool(
            registry,
            store=question_store,
            conversation_id=conversation_id,
            current_tool_call_id=current_tool_call_id,
            provider_key=provider_key,
            project_id=project_id,
        )
    return registry


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
    question_store: QuestionStore | None = None,
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

    `question_store` enables the `ask_user` tool. The loop carries the
    conversation id and tool-call id through accessors so the tool's
    closure can stage a Question keyed to the in-flight call without
    rebuilding the agent on every turn."""
    loop = AgentLoop(client=llm, tools=ToolRegistry())
    registry = build_tool_registry(
        conn=conn,
        provider=provider,
        store=store,
        active_item=active_item,
        read_only=read_only,
        provider_key=provider_key,
        project_id=project_id,
        mcp_manager=mcp_manager,
        question_store=question_store,
        conversation_id=loop.current_conversation_id,
        current_tool_call_id=loop.current_tool_call_id,
    )
    loop.set_tools(registry)
    return loop


__all__ = ["build_agent", "build_tool_registry", "register_readonly_tools"]
