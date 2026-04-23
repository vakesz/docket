"""Runtime context handed to `DocketApp` at construction.

Production code builds this from the CLI `Context` (resolved paths, opened
SQLite connection, configured providers, etc). Pilot tests build a minimal
form with fakes — anything optional (`paths`, `config`, `mcp_manager`, …)
is None and the affected features become no-ops or warning toasts."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from docket.agent.llm_client import LlmClient
from docket.agent.mcp import MCPManager
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.model import ItemKind, ScopeFilters
from docket.providers.base import WorkItemProvider


@dataclass
class TuiContext:
    """What the TUI needs from the caller to run. Kept small so the app can be mounted
    from production code (via Context) and from pilot-style tests (via fakes).

    Multi-provider shape: `providers` is the full set, `provider_key` selects
    the active one, and `provider` is a convenience alias that always points at
    `providers[provider_key]`. Callers that only have one backend can pass
    `provider=...` alone and a single-entry mapping is synthesized."""

    conn: sqlite3.Connection
    provider: WorkItemProvider
    scope: ScopeFilters
    scope_key: str = "default"
    providers: dict[str, WorkItemProvider] | None = None
    provider_key: str = ""
    llm: LlmClient | None = None  # None disables chat
    compaction_threshold_tokens: int = 0  # 0 disables — passed to conversation_service
    external_watch_interval_seconds: float = 60.0  # 0 disables external-update watcher
    # Read-only mode: agent mutating tools are not registered, TUI mutation
    # actions toast and bail, status bar shows a visible READ-ONLY badge.
    read_only: bool = False
    # Background list sync: 0 disables; the palette "Sync now" action still
    # works regardless. A per-provider floor (seconds) clamps very short
    # intervals — the resolver below takes the max of the configured global
    # and the floor for the active provider.
    background_sync_interval_seconds: float = 0.0
    background_sync_min_interval_by_provider: dict[str, float] | None = None
    # Stale marker: append `STALE - Xd` to list rows once `updated_at` is
    # older than N days. 0/negative disables. Per-provider override wins.
    stale_threshold_days: int = 0
    stale_threshold_by_provider: dict[str, int] | None = None
    default_new_item_kind: ItemKind = ItemKind.TASK
    show_acceptance_criteria: bool = True
    # Hide resolved/closed items from the backlog tree by default. Matches the
    # frontend's "open" state bucket; `c` toggles it at runtime. In-memory only —
    # not persisted — so a relaunch starts back at "hide done" on every provider.
    hide_done: bool = True
    # Optional handles for features that persist to config (theme picker, etc).
    # Pilot tests can leave these as None; persistence becomes a no-op.
    paths: Paths | None = None
    config: Config | None = None
    # Per-project MCP fleet. Built by `serve`/`open`; pilot tests leave it
    # `None` and the agent skips MCP tool registration entirely.
    mcp_manager: MCPManager | None = None


__all__ = ["TuiContext"]
