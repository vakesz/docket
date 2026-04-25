"""Mutable runtime state shared by API handlers that can switch provider/scope.

A single instance is built by `docket serve` and stored as `app.state.runtime`.
Scope/provider-switch endpoints mutate it under a lock; read endpoints snapshot
the fields they need. Routes that predate the runtime read `app.state.provider`
directly; `switch_provider` keeps that attribute in sync so both reader styles
see the same active provider.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock

from fastapi import FastAPI

from docket.agent.factory import build_agent
from docket.agent.mcp import MCPManager
from docket.config.models import Config
from docket.core.model import ScopeFilters, project_id_for
from docket.providers.base import WorkItemProvider


@dataclass
class RuntimeState:
    config: Config
    providers: dict[str, WorkItemProvider]
    provider_key: str
    scope_key: str
    last_sync_at: datetime | None = None
    offline: bool = False
    # Per-project MCP fleet. Optional so tests and surfaces that don't
    # use MCP can leave it `None`; when set, scope/provider switches
    # rebind the manager to the new project's server config.
    mcp_manager: MCPManager | None = None
    _lock: RLock = field(default_factory=RLock, repr=False, compare=False)

    @property
    def provider(self) -> WorkItemProvider:
        with self._lock:
            return self.providers[self.provider_key]

    @property
    def scope(self) -> ScopeFilters:
        with self._lock:
            entry = self.config.providers[self.provider_key]
            return entry.scopes[self.scope_key].to_core()

    @property
    def project_id(self) -> str:
        """Derived id for the active project (= provider key). Stable across
        renames; scopes share the same project so switching views doesn't
        change identity."""
        with self._lock:
            return project_id_for(self.provider_key)

    def switch_provider(self, key: str) -> None:
        with self._lock:
            if key not in self.providers:
                raise KeyError(key)
            self.provider_key = key
            self.scope_key = self.config.providers[key].active_scope
            self._rebind_mcp_locked()

    def switch_scope(self, key: str) -> None:
        with self._lock:
            entry = self.config.providers[self.provider_key]
            if key not in entry.scopes:
                raise KeyError(key)
            self.scope_key = key
            # Scope changes are view-only now — the MCP fleet is per-provider
            # and stays bound across view switches. No rebind needed.

    def _rebind_mcp_locked(self) -> None:
        """Switch the MCP fleet to match the current provider's project.

        Called after `switch_provider` — scope switches don't rebind,
        because the fleet follows the provider, not the view. No-op when
        no manager is wired in (tests, surfaces without MCP)."""
        if self.mcp_manager is None:
            return
        pid = project_id_for(self.provider_key)
        project = self.config.projects.get(pid)
        servers = dict(project.mcp) if project is not None else {}
        self.mcp_manager.bind_project(pid, servers)


def rebuild_agent(app: FastAPI, runtime: RuntimeState | None) -> None:
    """Re-bind `app.state.agent` from current `app.state` + `runtime`.

    The agent's tool closures capture (provider, provider_key, project_id) at
    build time. When any of those change at runtime, surfaces (HTTP route
    handlers, TUI scope-switch path) must rebuild the agent so the next chat
    turn uses the new bindings — otherwise tool calls keep reasoning over the
    previous backend or project.

    Sets `app.state.agent = None` when the LLM isn't configured. A
    provider/project switch invalidates any in-flight pending question
    because its closure was bound to the previous tuple."""
    state = app.state
    if state.llm is None:
        state.agent = None
        return
    question_store = getattr(state, "questions", None)
    if question_store is not None:
        question_store.clear()
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
        question_store=question_store,
    )


__all__ = ["RuntimeState", "rebuild_agent"]
