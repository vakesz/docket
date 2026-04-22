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

from docket.config.models import Config
from docket.core.model import ScopeFilters
from docket.providers.base import WorkItemProvider


@dataclass
class RuntimeState:
    config: Config
    providers: dict[str, WorkItemProvider]
    provider_key: str
    scope_key: str
    last_sync_at: datetime | None = None
    offline: bool = False
    _lock: RLock = field(default_factory=RLock, repr=False, compare=False)

    @property
    def provider(self) -> WorkItemProvider:
        with self._lock:
            return self.providers[self.provider_key]

    @property
    def scope(self) -> ScopeFilters:
        with self._lock:
            entry = self.config.providers[self.provider_key]
            sf = entry.scopes[self.scope_key]
            return ScopeFilters(
                team=sf.team,
                area_path=sf.area_path,
                iteration_path=sf.iteration_path,
                assignee=sf.assignee,
            )

    def switch_provider(self, key: str) -> None:
        with self._lock:
            if key not in self.providers:
                raise KeyError(key)
            self.provider_key = key
            self.scope_key = self.config.providers[key].active_scope

    def switch_scope(self, key: str) -> None:
        with self._lock:
            entry = self.config.providers[self.provider_key]
            if key not in entry.scopes:
                raise KeyError(key)
            self.scope_key = key


__all__ = ["RuntimeState"]
