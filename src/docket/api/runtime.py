"""Mutable runtime state shared by API handlers that can switch provider/view.

A single instance is built by `docket serve` and stored as `app.state.runtime`.
View/provider-switch endpoints mutate it under a lock; read endpoints snapshot
the fields they need. Routes that predate the runtime read `app.state.provider`
directly; `switch_provider` keeps that attribute in sync so both reader styles
see the same active provider.

`view_overrides` carries chip-bar selections the user made in this session
that the saved view doesn't reflect. They live on the runtime (not in
`config.toml`) so they vanish on restart and on provider/project switch —
exactly the "session-only" semantic the chip bar promises.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock

from fastapi import FastAPI

from docket.agent.factory import build_agent
from docket.agent.mcp import MCPManager
from docket.config.models import Config, SavedView
from docket.core.model import ScopeFilters, project_id_for
from docket.providers.base import WorkItemProvider


@dataclass
class RuntimeState:
    config: Config
    providers: dict[str, WorkItemProvider]
    provider_key: str
    last_sync_at: datetime | None = None
    offline: bool = False
    # Per-project MCP fleet. Optional so tests and surfaces that don't
    # use MCP can leave it `None`; when set, provider switches rebind the
    # manager to the new project's server config.
    mcp_manager: MCPManager | None = None
    # Session-only chip-bar overrides keyed by `provider_key`. Cleared on
    # provider switch and on process restart — to persist a change, the
    # user edits the saved view via Settings → Providers.
    view_overrides: dict[str, SavedView] = field(default_factory=dict)
    _lock: RLock = field(default_factory=RLock, repr=False, compare=False)

    @property
    def provider(self) -> WorkItemProvider:
        with self._lock:
            return self.providers[self.provider_key]

    @property
    def active_view_name(self) -> str:
        with self._lock:
            return self.config.providers[self.provider_key].active_view

    @property
    def saved_view(self) -> SavedView:
        """The persisted saved view selected for the active provider."""
        with self._lock:
            entry = self.config.providers[self.provider_key]
            return entry.views.get(entry.active_view, SavedView())

    @property
    def scope(self) -> ScopeFilters:
        """Effective view filter — saved view + session overrides merged."""
        with self._lock:
            return self._effective_view_locked().to_core()

    @property
    def effective_view(self) -> SavedView:
        """Saved view + session overrides as a single `SavedView`.

        Surfaces use this to render the chip bar in its current state
        without re-implementing the merge."""
        with self._lock:
            return self._effective_view_locked()

    @property
    def has_view_overrides(self) -> bool:
        with self._lock:
            return self.provider_key in self.view_overrides

    def _effective_view_locked(self) -> SavedView:
        """Merge session overrides on top of the active saved view.

        Override semantics: any field the user touched this session wins
        outright. Untouched fields fall through to the saved view. The
        chip bar always sets every field on the override, so in practice
        an override is a complete replacement — but the merge keeps
        partial overrides honest."""
        saved = self.saved_view
        override = self.view_overrides.get(self.provider_key)
        if override is None:
            return saved
        return SavedView(
            assignees=list(override.assignees) if override.assignees else list(saved.assignees),
            axes=dict(override.axes) if override.axes else dict(saved.axes),
            state_bucket=override.state_bucket,
        )

    @property
    def project_id(self) -> str:
        """Derived id for the active project (= provider key). Stable across
        renames; views share the same project so switching views doesn't
        change identity."""
        with self._lock:
            return project_id_for(self.provider_key)

    def switch_provider(self, key: str) -> None:
        with self._lock:
            if key not in self.providers:
                raise KeyError(key)
            # Session overrides belong to the previous provider; clear so
            # the new provider starts on its persisted active view.
            self.view_overrides.clear()
            self.provider_key = key
            self._rebind_mcp_locked()

    def switch_view(self, name: str) -> None:
        """Activate `name` on the current provider and clear session overrides.

        Activating a saved view is the user's signal that they want the
        persisted defaults — any in-session chip tweaks are dropped. The
        MCP fleet is per-provider, so view switches don't rebind it."""
        with self._lock:
            entry = self.config.providers[self.provider_key]
            if name not in entry.views:
                raise KeyError(name)
            entry.active_view = name
            self.view_overrides.pop(self.provider_key, None)

    def set_view_overrides(self, override: SavedView | None) -> None:
        """Replace this session's chip-bar overrides for the active provider.

        Pass `None` to clear (chip-bar "reset" button). The override is
        bound to `provider_key` so switching providers wipes them — exactly
        the semantic the chip bar promises."""
        with self._lock:
            if override is None:
                self.view_overrides.pop(self.provider_key, None)
            else:
                self.view_overrides[self.provider_key] = override

    def _rebind_mcp_locked(self) -> None:
        """Switch the MCP fleet to match the current provider's project.

        Called after `switch_provider` — view switches don't rebind,
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
    handlers, TUI view-switch path) must rebuild the agent so the next chat
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
