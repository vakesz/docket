"""Shared helper for (re)building the agent loop on the FastAPI app.

The agent's tool closures capture (provider, provider_key, project_id) at
build time. When any of those change at runtime, surfaces (HTTP route
handlers, TUI scope-switch path) must rebuild the agent so the next chat
turn uses the new bindings — otherwise tool calls keep reasoning over the
previous backend or project.

`rebuild_agent` doubles as the initial-build path: `create_app` calls it
once after wiring `app.state` so there's a single code path that reads
state + runtime and produces an agent."""

from __future__ import annotations

from fastapi import FastAPI

from docket.agent.factory import build_agent
from docket.api.runtime import RuntimeState


def rebuild_agent(app: FastAPI, runtime: RuntimeState | None) -> None:
    """Re-bind `app.state.agent` from current `app.state` + `runtime`.

    Sets `app.state.agent = None` when the LLM isn't configured. Reads
    `active_item` from `app.state` so callers don't have to thread the
    callable through the rebuild path on every provider/project switch."""
    state = app.state
    if state.llm is None:
        state.agent = None
        return
    state.agent = build_agent(
        llm=state.llm,
        conn=state.conn,
        provider=runtime.provider if runtime is not None else state.provider,
        store=state.proposals,
        active_item=getattr(state, "active_item", None) or (lambda: None),
        read_only=bool(getattr(state, "read_only", False)),
        provider_key=runtime.provider_key if runtime is not None else "",
        project_id=runtime.project_id if runtime is not None else "",
        mcp_manager=runtime.mcp_manager if runtime is not None else None,
    )


__all__ = ["rebuild_agent"]
