"""Shared helper for rebuilding the agent loop on scope/provider switches.

The agent's tool closures capture (provider, provider_key, project_id) at
build time. When any of those change at runtime, surfaces (HTTP route
handlers, TUI scope-switch path) must rebuild the agent so the next chat
turn uses the new bindings — otherwise tool calls keep reasoning over the
previous backend or project."""

from __future__ import annotations

from fastapi import Request

from docket.agent.factory import build_agent
from docket.api.runtime import RuntimeState


def rebuild_agent(request: Request, runtime: RuntimeState) -> None:
    """Re-bind the agent on `request.app.state.agent` to the current runtime.

    No-op when the LLM isn't configured (chat is disabled in that case)."""
    state = request.app.state
    if state.llm is None:
        return
    state.agent = build_agent(
        llm=state.llm,
        conn=state.conn,
        provider=runtime.provider,
        store=state.proposals,
        active_item=lambda: None,
        read_only=bool(getattr(state, "read_only", False)),
        provider_key=runtime.provider_key,
        project_id=runtime.project_id,
        mcp_manager=runtime.mcp_manager,
    )


__all__ = ["rebuild_agent"]
