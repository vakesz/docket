"""Mutable runtime state shared by API handlers that can switch provider/scope.

A single instance is built by `docket serve` and stored as `app.state.runtime`.
Scope/provider-switch endpoints mutate it under a lock; read endpoints snapshot
the fields they need. The existing routes still read `app.state.provider` for
backwards compatibility; `switch_provider` keeps that attribute in sync.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from threading import RLock

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
        """Derived id for the active (provider, scope). Stable across renames."""
        with self._lock:
            return project_id_for(self.provider_key, self.scope_key)

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
            self._rebind_mcp_locked()

    def _rebind_mcp_locked(self) -> None:
        """Switch the MCP fleet to match the current (provider, scope) project.

        No-op when no manager is wired in (tests, surfaces without MCP).
        Called with `_lock` held so the new `project_id` is derived from
        a consistent snapshot."""
        if self.mcp_manager is None:
            return
        pid = project_id_for(self.provider_key, self.scope_key)
        project = self.config.projects.get(pid)
        servers = dict(project.mcp) if project is not None else {}
        self.mcp_manager.bind_project(pid, servers)


__all__ = ["RuntimeState"]
