"""`docket status` — Rich renderer for the install health snapshot.

Thin adapter: resolve a Context, ask `status_service.collect(...)` for a
`StatusSnapshot`, render with Rich. All data gathering (SQL counts, log
tailing, MCP wiring) lives in the service so other surfaces (HTTP, TUI
palette, JSON-out) can reuse it without re-importing Rich or Typer.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from docket.cli.context import prepare_or_wizard
from docket.core.services import status_service
from docket.core.services.status_service import StatusSnapshot

console = Console()


def status_command(
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="Also show the last few tool / proposal / MCP events from the log.",
    ),
) -> None:
    """Print a health snapshot of the active install (paths, cache, sync, MCP)."""
    ctx = prepare_or_wizard()
    try:
        snapshot = status_service.collect(
            conn=ctx.conn,
            config=ctx.config,
            paths=ctx.paths,
            active_provider=ctx.active_provider or "",
            include_recent_events=verbose,
        )
        _render(snapshot, verbose=verbose)
    finally:
        ctx.close()


def _render(snap: StatusSnapshot, *, verbose: bool = False) -> None:
    console.print("[bold]Docket status[/bold]")
    console.print()

    # --- Active project
    overview = Table(show_header=False, box=None, pad_edge=False)
    overview.add_column(style="dim", no_wrap=True)
    overview.add_column()
    overview.add_row(
        "Project",
        f"[cyan]{snap.project_name}[/cyan]  [dim]({snap.project_id})[/dim]",
    )
    display = snap.provider_display_name
    overview.add_row(
        "Provider",
        f"{snap.active_provider}" + (f"  [dim]({display})[/dim]" if display else ""),
    )
    overview.add_row("View", snap.scope_key)
    console.print(overview)
    console.print()

    # --- Paths
    paths = Table(title="Paths", show_header=False, box=None, pad_edge=False, title_style="bold")
    paths.add_column(style="dim", no_wrap=True)
    paths.add_column()
    paths.add_row("Config", _path_with_size(snap.config_file))
    paths.add_row("Database", _path_with_size(snap.db_file))
    paths.add_row("Prompts dir", str(snap.prompts_dir))
    paths.add_row("Log dir", str(snap.log_dir))
    console.print(paths)
    console.print()

    # --- Cache row counts
    counts = snap.counts
    cache = Table(title="Cache", show_header=False, box=None, pad_edge=False, title_style="bold")
    cache.add_column(style="dim", no_wrap=True)
    cache.add_column(justify="right")
    cache.add_column()
    cache.add_row(
        "Items",
        f"{counts.items_total:>6}",
        f"[dim]({counts.items_active} active · {counts.items_archived} archived)[/dim]",
    )
    cache.add_row("Comments", f"{counts.comments:>6}", "")
    cache.add_row(
        "Conversations",
        f"{counts.conversations_total:>6}",
        f"[dim]({counts.conversations_active} active · "
        f"{counts.conversations_archived} archived)[/dim]",
    )
    cache.add_row("Messages", f"{counts.messages:>6}", "")
    cache.add_row("Memory entries", f"{counts.memory:>6}", "")
    cache.add_row("Sources", f"{counts.sources:>6}", "")
    cache.add_row("Watchlist", f"{counts.watchlist:>6}", "")
    cache.add_row("Projects", f"{counts.projects:>6}", "")
    console.print(cache)
    console.print()

    # --- Sync state
    sync = Table(title="Sync state", title_style="bold")
    sync.add_column("Provider", style="cyan")
    sync.add_column("Last full sync", style="green")
    sync.add_column("Watermark", style="yellow")
    if snap.sync_rows:
        for row in snap.sync_rows:
            sync.add_row(
                row.provider_key,
                _fmt_iso(row.last_full_sync_at),
                _fmt_iso(row.watermark_iso),
            )
        console.print(sync)
    else:
        console.print(
            "[dim]Sync state:[/dim] no syncs recorded yet "
            "[dim](try `docket sync` to populate the cache).[/dim]"
        )
    console.print()

    # --- MCP fleet for the active project
    if snap.mcp_servers:
        mcp_table = Table(title="MCP servers (active project)", title_style="bold")
        mcp_table.add_column("Name", style="cyan")
        mcp_table.add_column("Enabled", style="green")
        mcp_table.add_column("Transport", style="magenta")
        mcp_table.add_column("Command", style="yellow")
        mcp_table.add_column("Args", style="dim")
        for name, entry in snap.mcp_servers.items():
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
    telemetry.add_row("Enabled", "yes" if snap.telemetry_enabled else "no")
    telemetry.add_row("Level", snap.telemetry_level)
    telemetry.add_row("Log file", _path_with_size(snap.log_file))
    console.print(telemetry)
    console.print()

    # --- HTTP surface
    http = Table(title="HTTP", show_header=False, box=None, pad_edge=False, title_style="bold")
    http.add_column(style="dim", no_wrap=True)
    http.add_column()
    http.add_row("Enabled", "yes" if snap.http_enabled else "no")
    http.add_row("Bind", f"{snap.http_bind}:{snap.http_port}")
    http.add_row("Token", "set" if snap.http_token_set else "unset")
    console.print(http)

    if verbose:
        console.print()
        _render_recent_events(snap)


def _render_recent_events(snap: StatusSnapshot) -> None:
    console.print("[bold]Recent events[/bold]")
    if not snap.log_file.exists():
        console.print("[dim]No log file yet.[/dim]")
        return
    if not snap.recent_events:
        console.print("[dim]No tool / proposal / MCP events in the recent log window.[/dim]")
        return
    table = Table(show_header=True, box=None, pad_edge=False, header_style="dim")
    table.add_column("Time", style="dim", no_wrap=True)
    table.add_column("Event", style="cyan")
    table.add_column("Target")
    table.add_column("Outcome")
    table.add_column("ms", justify="right", style="dim")
    for evt in snap.recent_events:
        table.add_row(
            _fmt_event_ts(evt.get("timestamp")),
            str(evt.get("event", "—")),
            _event_target(evt),
            _event_outcome(evt),
            _fmt_latency(evt.get("latency_ms")),
        )
    console.print(table)


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
