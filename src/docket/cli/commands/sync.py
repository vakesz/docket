from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.context import prepare_or_wizard
from docket.core.services import sync_service

console = Console()


def sync_command(
    full: bool = typer.Option(False, "--full", help="Reset watermark and resync everything in scope."),
    scope: str | None = typer.Option(None, "--scope", help="Named scope to sync (defaults to active scope)."),
) -> None:
    """Refresh the local cache from Azure DevOps."""
    ctx = prepare_or_wizard()
    try:
        filters = ctx.scope_filters(scope)
        scope_key = scope or ctx.config.active_scope
        with console.status(f"Syncing scope '{scope_key}'..."):
            fn = sync_service.full_refresh if full else sync_service.refresh
            summary = fn(ctx.conn, ctx.provider, scope_key, filters)
        console.print(
            f"[green]✓[/green] synced {summary.upserted} item(s), "
            f"archived {summary.archived}, watermark → {summary.watermark}"
        )
    finally:
        ctx.close()
