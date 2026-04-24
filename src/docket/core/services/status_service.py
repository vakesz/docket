"""Data-gathering for `docket status` / any headless status surface.

The Typer command stays thin: ask the service for a `StatusSnapshot`, hand
the snapshot to the Rich renderer. The service is the one place that knows
the SQL shape of the cache counts, how to stitch `project_repo` +
`mcp_service` against the active provider, and what counts as a "recent"
log event. Other surfaces (HTTP, TUI palette action, future JSON-out
mode) can call `collect` directly without going through Typer.

No I/O beyond the passed-in SQLite connection + log file tail; no Rich
objects — rendering is the caller's job."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from docket.config.models import Config, MCPServerEntry, TelemetryLevel
from docket.config.paths import Paths
from docket.core.model import project_id_for
from docket.core.services import mcp_service
from docket.storage.repos import project_repo
from docket.telemetry.log_reader import tail_events

VERBOSE_EVENT_TYPES: tuple[str, ...] = ("tool_call", "proposal_confirm", "mcp_bind")
"""Event names surfaced by `docket status --verbose`. Tool calls, mutation
confirmations, and MCP binding round-trips are the three things worth
tailing from the structured log."""


@dataclass(frozen=True)
class CacheCounts:
    """Row counts from the local SQLite cache. Active/archived splits are
    separated out rather than computed at the render site so callers can
    decide how to present them."""

    items_total: int
    items_active: int
    items_archived: int
    comments: int
    conversations_total: int
    conversations_active: int
    conversations_archived: int
    messages: int
    memory: int
    sources: int
    watchlist: int
    projects: int


@dataclass(frozen=True)
class SyncStateRow:
    provider_key: str
    watermark_iso: str | None
    last_full_sync_at: str | None


@dataclass(frozen=True)
class StatusSnapshot:
    """Everything `docket status` needs, in render-ready shape.

    `active_provider` / `scope_key` / `project_name` fall back to `"—"` when
    no provider is configured — the renderer doesn't need to special-case
    missing values."""

    active_provider: str
    provider_display_name: str
    scope_key: str
    project_id: str
    project_name: str
    config_file: Path
    db_file: Path
    prompts_dir: Path
    log_dir: Path
    log_file: Path
    counts: CacheCounts
    sync_rows: list[SyncStateRow]
    mcp_servers: dict[str, MCPServerEntry]
    telemetry_enabled: bool
    telemetry_level: TelemetryLevel
    http_enabled: bool
    http_bind: str
    http_port: int
    http_token_set: bool
    recent_events: list[dict[str, Any]] = field(default_factory=list)


def collect(
    *,
    conn: sqlite3.Connection,
    config: Config,
    paths: Paths,
    active_provider: str,
    include_recent_events: bool = False,
    recent_events_limit: int = 5,
) -> StatusSnapshot:
    """Assemble a full snapshot. `include_recent_events=True` costs one log
    file read; leave it off for the non-verbose path so plain
    `docket status` doesn't tail a potentially-large log every run."""
    provider_entry = config.providers.get(active_provider) if active_provider else None
    scope_key = provider_entry.active_scope if provider_entry else "—"
    resolved_provider = active_provider or "—"

    project = project_repo.get(conn, project_id_for(active_provider)) if active_provider else None
    project_id = project.id if project else resolved_provider
    project_name = project.name if project else "—"

    log_file = paths.log_dir / "docket.log"
    recent_events = (
        tail_events(log_file, event_types=VERBOSE_EVENT_TYPES, limit=recent_events_limit)
        if include_recent_events and log_file.exists()
        else []
    )

    return StatusSnapshot(
        active_provider=resolved_provider,
        provider_display_name=provider_entry.display_name if provider_entry else "",
        scope_key=scope_key,
        project_id=project_id,
        project_name=project_name,
        config_file=paths.config_file,
        db_file=paths.db_file,
        prompts_dir=paths.prompts_dir,
        log_dir=paths.log_dir,
        log_file=log_file,
        counts=_cache_counts(conn),
        sync_rows=_sync_rows(conn),
        mcp_servers=(mcp_service.list_servers(config, project_id) if project else {}),
        telemetry_enabled=config.telemetry.enabled,
        telemetry_level=config.telemetry.level,
        http_enabled=config.http.enabled,
        http_bind=config.http.bind,
        http_port=config.http.port,
        http_token_set=bool(config.http.token),
        recent_events=recent_events,
    )


def _cache_counts(conn: sqlite3.Connection) -> CacheCounts:
    def scalar(sql: str) -> int:
        row = conn.execute(sql).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    items_active = scalar("SELECT COUNT(*) FROM items WHERE archived = 0")
    items_archived = scalar("SELECT COUNT(*) FROM items WHERE archived = 1")
    conv_active = scalar("SELECT COUNT(*) FROM conversations WHERE archived_at IS NULL")
    conv_archived = scalar("SELECT COUNT(*) FROM conversations WHERE archived_at IS NOT NULL")
    return CacheCounts(
        items_total=items_active + items_archived,
        items_active=items_active,
        items_archived=items_archived,
        comments=scalar("SELECT COUNT(*) FROM comments"),
        conversations_total=conv_active + conv_archived,
        conversations_active=conv_active,
        conversations_archived=conv_archived,
        messages=scalar("SELECT COUNT(*) FROM messages"),
        memory=scalar("SELECT COUNT(*) FROM memory"),
        sources=scalar("SELECT COUNT(*) FROM sources"),
        watchlist=scalar("SELECT COUNT(*) FROM watchlist"),
        projects=scalar("SELECT COUNT(*) FROM projects"),
    )


def _sync_rows(conn: sqlite3.Connection) -> list[SyncStateRow]:
    rows = conn.execute(
        "SELECT provider_key, watermark_iso, last_full_sync_at "
        "FROM sync_state ORDER BY provider_key"
    ).fetchall()
    return [
        SyncStateRow(
            provider_key=row["provider_key"],
            watermark_iso=row["watermark_iso"],
            last_full_sync_at=row["last_full_sync_at"],
        )
        for row in rows
    ]


__all__ = [
    "VERBOSE_EVENT_TYPES",
    "CacheCounts",
    "StatusSnapshot",
    "SyncStateRow",
    "collect",
]
