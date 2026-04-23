"""`docket status` — health snapshot for the local install.

Single-pane view of: active project, on-disk paths, cache row counts,
sync watermarks, MCP fleet for the active project, telemetry config, and
HTTP surface state. Read-only — never mutates or refreshes; pair with
`docket sync` if the cache looks stale.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from pathlib import Path

from rich.console import Console
from rich.table import Table

from docket.cli.context import Context, prepare_or_wizard
from docket.core.services import mcp_service, project_service

console = Console()


def status_command() -> None:
    """Print a health snapshot of the active install (paths, cache, sync, MCP)."""
    ctx = prepare_or_wizard()
    try:
        _render(ctx)
    finally:
        ctx.close()


def _render(ctx: Context) -> None:
    cfg = ctx.config
    active_provider = ctx.active_provider or "—"
    provider_entry = cfg.providers.get(active_provider) if active_provider != "—" else None
    scope_key = provider_entry.active_scope if provider_entry else "—"
    project = project_service.get_by_scope(
        ctx.conn, provider_key=active_provider, scope_key=scope_key
    )
    project_id = project.id if project else f"{active_provider}::{scope_key}"
    project_name = project.name if project else "—"

    console.print("[bold]Docket status[/bold]")
    console.print()

    # --- Active project
    overview = Table(show_header=False, box=None, pad_edge=False)
    overview.add_column(style="dim", no_wrap=True)
    overview.add_column()
    overview.add_row("Project", f"[cyan]{project_name}[/cyan]  [dim]({project_id})[/dim]")
    display = provider_entry.display_name if provider_entry else ""
    overview.add_row(
        "Provider",
        f"{active_provider}" + (f"  [dim]({display})[/dim]" if display else ""),
    )
    overview.add_row("Scope", scope_key)
    console.print(overview)
    console.print()

    # --- Paths
    paths = Table(title="Paths", show_header=False, box=None, pad_edge=False, title_style="bold")
    paths.add_column(style="dim", no_wrap=True)
    paths.add_column()
    paths.add_row("Config", _path_with_size(ctx.paths.config_file))
    paths.add_row("Database", _path_with_size(ctx.paths.db_file))
    paths.add_row("Prompts dir", str(ctx.paths.prompts_dir))
    paths.add_row("Log dir", str(ctx.paths.log_dir))
    console.print(paths)
    console.print()

    # --- Cache row counts
    counts = _cache_counts(ctx.conn)
    cache = Table(title="Cache", show_header=False, box=None, pad_edge=False, title_style="bold")
    cache.add_column(style="dim", no_wrap=True)
    cache.add_column(justify="right")
    cache.add_column()
    cache.add_row(
        "Items",
        f"{counts['items_total']:>6}",
        f"[dim]({counts['items_active']} active · {counts['items_archived']} archived)[/dim]",
    )
    cache.add_row("Comments", f"{counts['comments']:>6}", "")
    cache.add_row(
        "Conversations",
        f"{counts['conversations_total']:>6}",
        f"[dim]({counts['conversations_active']} active · "
        f"{counts['conversations_archived']} archived)[/dim]",
    )
    cache.add_row("Messages", f"{counts['messages']:>6}", "")
    cache.add_row("Memory entries", f"{counts['memory']:>6}", "")
    cache.add_row("Sources", f"{counts['sources']:>6}", "")
    cache.add_row("Watchlist", f"{counts['watchlist']:>6}", "")
    cache.add_row("Projects", f"{counts['projects']:>6}", "")
    console.print(cache)
    console.print()

    # --- Sync state
    sync = Table(title="Sync state", title_style="bold")
    sync.add_column("Scope", style="cyan")
    sync.add_column("Last full sync", style="green")
    sync.add_column("Watermark", style="yellow")
    rows = ctx.conn.execute(
        "SELECT scope_key, watermark_iso, last_full_sync_at FROM sync_state ORDER BY scope_key"
    ).fetchall()
    if rows:
        for row in rows:
            sync.add_row(
                row["scope_key"],
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
    servers = mcp_service.list_servers(cfg, project_id) if project else {}
    if servers:
        mcp_table = Table(title="MCP servers (active project)", title_style="bold")
        mcp_table.add_column("Name", style="cyan")
        mcp_table.add_column("Enabled", style="green")
        mcp_table.add_column("Transport", style="magenta")
        mcp_table.add_column("Command", style="yellow")
        mcp_table.add_column("Args", style="dim")
        for name, entry in servers.items():
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
    telemetry.add_row("Enabled", "yes" if cfg.telemetry.enabled else "no")
    telemetry.add_row("Level", cfg.telemetry.level)
    log_file = ctx.paths.log_dir / "docket.log"
    telemetry.add_row("Log file", _path_with_size(log_file))
    console.print(telemetry)
    console.print()

    # --- HTTP surface
    http = Table(title="HTTP", show_header=False, box=None, pad_edge=False, title_style="bold")
    http.add_column(style="dim", no_wrap=True)
    http.add_column()
    http.add_row("Enabled", "yes" if cfg.http.enabled else "no")
    http.add_row("Bind", f"{cfg.http.bind}:{cfg.http.port}")
    http.add_row("Token", "set" if cfg.http.token else "unset")
    console.print(http)


def _cache_counts(conn: sqlite3.Connection) -> dict[str, int]:
    def _scalar(sql: str) -> int:
        row = conn.execute(sql).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    items_active = _scalar("SELECT COUNT(*) FROM items WHERE archived = 0")
    items_archived = _scalar("SELECT COUNT(*) FROM items WHERE archived = 1")
    conv_active = _scalar("SELECT COUNT(*) FROM conversations WHERE archived_at IS NULL")
    conv_archived = _scalar("SELECT COUNT(*) FROM conversations WHERE archived_at IS NOT NULL")
    return {
        "items_total": items_active + items_archived,
        "items_active": items_active,
        "items_archived": items_archived,
        "comments": _scalar("SELECT COUNT(*) FROM comments"),
        "conversations_total": conv_active + conv_archived,
        "conversations_active": conv_active,
        "conversations_archived": conv_archived,
        "messages": _scalar("SELECT COUNT(*) FROM messages"),
        "memory": _scalar("SELECT COUNT(*) FROM memory"),
        "sources": _scalar("SELECT COUNT(*) FROM sources"),
        "watchlist": _scalar("SELECT COUNT(*) FROM watchlist"),
        "projects": _scalar("SELECT COUNT(*) FROM projects"),
    }


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
