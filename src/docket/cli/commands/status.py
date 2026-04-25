"""`docket status` — health snapshot of the active install.

Single-file: gather counts straight from SQLite, ask `mcp_service` and
`project_repo` for their slices, render with Rich. No marshalling layer —
the dataclass round-trip wasn't earning its keep when there's only one
caller.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any

import typer
from rich.table import Table

from docket.cli._console import console
from docket.cli.context import prepare_or_wizard
from docket.core.model import project_id_for
from docket.core.services import mcp_service
from docket.storage.repos import project_repo
from docket.telemetry.log_reader import tail_events

VERBOSE_EVENT_TYPES: tuple[str, ...] = ("tool_call", "proposal_confirm", "mcp_bind")
"""Event names surfaced by `docket status --verbose`. Tool calls, mutation
confirmations, and MCP binding round-trips are the three things worth
tailing from the structured log."""


def status_command(
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="Also show the last few tool / proposal / MCP events from the log.",
    ),
) -> None:
    """Print a health snapshot of the active install (paths, cache, sync, MCP)."""
    with prepare_or_wizard() as ctx:
        active_provider = ctx.active_provider or ""
        provider_entry = ctx.config.providers.get(active_provider) if active_provider else None
        scope_key = provider_entry.active_scope if provider_entry else "—"
        resolved_provider = active_provider or "—"

        project = (
            project_repo.get(ctx.conn, project_id_for(active_provider))
            if active_provider
            else None
        )
        project_id = project.id if project else resolved_provider
        project_name = project.name if project else "—"
        log_file = ctx.paths.log_dir / "docket.log"

        console.print("[bold]Docket status[/bold]")
        console.print()

        # --- Active project
        overview = Table(show_header=False, box=None, pad_edge=False)
        overview.add_column(style="dim", no_wrap=True)
        overview.add_column()
        overview.add_row(
            "Project",
            f"[cyan]{project_name}[/cyan]  [dim]({project_id})[/dim]",
        )
        display = provider_entry.display_name if provider_entry else ""
        overview.add_row(
            "Provider",
            f"{resolved_provider}" + (f"  [dim]({display})[/dim]" if display else ""),
        )
        overview.add_row("View", scope_key)
        console.print(overview)
        console.print()

        # --- Paths
        paths = Table(
            title="Paths", show_header=False, box=None, pad_edge=False, title_style="bold"
        )
        paths.add_column(style="dim", no_wrap=True)
        paths.add_column()
        paths.add_row("Config", _path_with_size(ctx.paths.config_file))
        paths.add_row("Database", _path_with_size(ctx.paths.db_file))
        paths.add_row("Prompts dir", str(ctx.paths.prompts_dir))
        paths.add_row("Log dir", str(ctx.paths.log_dir))
        console.print(paths)
        console.print()

        # --- Cache row counts
        items_active = _scalar(ctx.conn, "SELECT COUNT(*) FROM items WHERE archived = 0")
        items_archived = _scalar(ctx.conn, "SELECT COUNT(*) FROM items WHERE archived = 1")
        conv_active = _scalar(
            ctx.conn, "SELECT COUNT(*) FROM conversations WHERE archived_at IS NULL"
        )
        conv_archived = _scalar(
            ctx.conn, "SELECT COUNT(*) FROM conversations WHERE archived_at IS NOT NULL"
        )
        cache = Table(
            title="Cache", show_header=False, box=None, pad_edge=False, title_style="bold"
        )
        cache.add_column(style="dim", no_wrap=True)
        cache.add_column(justify="right")
        cache.add_column()
        cache.add_row(
            "Items",
            f"{items_active + items_archived:>6}",
            f"[dim]({items_active} active · {items_archived} archived)[/dim]",
        )
        cache.add_row("Comments", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM comments'):>6}", "")
        cache.add_row(
            "Conversations",
            f"{conv_active + conv_archived:>6}",
            f"[dim]({conv_active} active · {conv_archived} archived)[/dim]",
        )
        cache.add_row("Messages", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM messages'):>6}", "")
        cache.add_row("Memory entries", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM memory'):>6}", "")
        cache.add_row("Sources", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM sources'):>6}", "")
        cache.add_row("Watchlist", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM watchlist'):>6}", "")
        cache.add_row("Projects", f"{_scalar(ctx.conn, 'SELECT COUNT(*) FROM projects'):>6}", "")
        console.print(cache)
        console.print()

        # --- Sync state
        sync_rows = ctx.conn.execute(
            "SELECT provider_key, watermark_iso, last_full_sync_at "
            "FROM sync_state ORDER BY provider_key"
        ).fetchall()
        if sync_rows:
            sync = Table(title="Sync state", title_style="bold")
            sync.add_column("Provider", style="cyan")
            sync.add_column("Last full sync", style="green")
            sync.add_column("Watermark", style="yellow")
            for row in sync_rows:
                sync.add_row(
                    row["provider_key"],
                    _fmt_iso(row["last_full_sync_at"]),
                    _fmt_iso(row["watermark_iso"]),
                )
            console.print(sync)
        else:
            console.print(
                "[dim]Sync state:[/dim] no syncs recorded yet "
                "[dim](try `docket sync` to populate the cache).[/dim]"
            )
        console.print()

        # --- MCP fleet for the active project
        mcp_servers = mcp_service.list_servers(ctx.config, project_id) if project else {}
        if mcp_servers:
            mcp_table = Table(title="MCP servers (active project)", title_style="bold")
            mcp_table.add_column("Name", style="cyan")
            mcp_table.add_column("Enabled", style="green")
            mcp_table.add_column("Transport", style="magenta")
            mcp_table.add_column("Command", style="yellow")
            mcp_table.add_column("Args", style="dim")
            for name, entry in mcp_servers.items():
                mcp_table.add_row(
                    name,
                    "yes" if entry.enabled else "no",
                    entry.transport,
                    entry.command or "—",
                    " ".join(entry.args),
                )
            console.print(mcp_table)
        else:
            console.print(
                "[dim]MCP servers:[/dim] none configured for the active project "
                "[dim](add with `docket mcp add`).[/dim]"
            )
        console.print()

        # --- Telemetry
        telemetry = Table(
            title="Telemetry", show_header=False, box=None, pad_edge=False, title_style="bold"
        )
        telemetry.add_column(style="dim", no_wrap=True)
        telemetry.add_column()
        telemetry.add_row("Enabled", "yes" if ctx.config.telemetry.enabled else "no")
        telemetry.add_row("Level", ctx.config.telemetry.level)
        telemetry.add_row("Log file", _path_with_size(log_file))
        console.print(telemetry)
        console.print()

        # --- HTTP surface
        http = Table(title="HTTP", show_header=False, box=None, pad_edge=False, title_style="bold")
        http.add_column(style="dim", no_wrap=True)
        http.add_column()
        http.add_row("Enabled", "yes" if ctx.config.http.enabled else "no")
        http.add_row("Bind", f"{ctx.config.http.bind}:{ctx.config.http.port}")
        http.add_row("Token", "set" if ctx.config.http.token else "unset")
        console.print(http)

        if verbose:
            console.print()
            _render_recent_events(log_file)


def _render_recent_events(log_file: Path) -> None:
    console.print("[bold]Recent events[/bold]")
    if not log_file.exists():
        console.print("[dim]No log file yet.[/dim]")
        return
    events = tail_events(log_file, event_types=VERBOSE_EVENT_TYPES, limit=5)
    if not events:
        console.print("[dim]No tool / proposal / MCP events in the recent log window.[/dim]")
        return
    table = Table(show_header=True, box=None, pad_edge=False, header_style="dim")
    table.add_column("Time", style="dim", no_wrap=True)
    table.add_column("Event", style="cyan")
    table.add_column("Target")
    table.add_column("Outcome")
    table.add_column("ms", justify="right", style="dim")
    for evt in events:
        table.add_row(
            _fmt_event_ts(evt.get("timestamp")),
            str(evt.get("event", "—")),
            _event_target(evt),
            _event_outcome(evt),
            _fmt_latency(evt.get("latency_ms")),
        )
    console.print(table)


def _scalar(conn: sqlite3.Connection, sql: str) -> int:
    row = conn.execute(sql).fetchone()
    return int(row[0]) if row and row[0] is not None else 0


def _event_target(evt: dict[str, Any]) -> str:
    kind = evt.get("event")
    if kind == "tool_call":
        return str(evt.get("tool_name", "—"))
    if kind == "proposal_confirm":
        return str(evt.get("proposal_type", "—"))
    if kind == "mcp_bind":
        name = evt.get("tool_name") or evt.get("project") or "—"
        return str(name)
    return "—"


def _event_outcome(evt: dict[str, Any]) -> str:
    outcome = str(evt.get("outcome", "—"))
    err = evt.get("error_type")
    if err:
        return f"[red]{outcome}[/red] [dim]({err})[/dim]"
    if outcome == "ok":
        return f"[green]{outcome}[/green]"
    if outcome in {"error", "timeout", "denied"}:
        return f"[red]{outcome}[/red]"
    return outcome


def _fmt_event_ts(value: Any) -> str:
    if not isinstance(value, str):
        return "—"
    # structlog emits ISO-8601 with trailing 'Z'; keep the HH:MM:SS portion.
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).strftime("%H:%M:%S")
    except ValueError:
        return value[:19] if len(value) >= 19 else value


def _fmt_latency(value: Any) -> str:
    if value is None:
        return "—"
    try:
        return f"{int(float(value))}"
    except (TypeError, ValueError):
        return str(value)


def _path_with_size(path: Path) -> str:
    if not path.exists():
        return f"{path}  [dim](missing)[/dim]"
    try:
        size = path.stat().st_size
    except OSError:
        return str(path)
    return f"{path}  [dim]({_human_bytes(size)})[/dim]"


def _human_bytes(n: int) -> str:
    step = 1024.0
    for unit in ("B", "KB", "MB", "GB"):
        if n < step:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} {unit}"
        n = int(n / step)
    return f"{n:.1f} TB"


def _fmt_iso(value: str | None) -> str:
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(value).strftime("%Y-%m-%d %H:%M:%S %Z").strip()
    except ValueError:
        return value


__all__ = ["status_command"]
