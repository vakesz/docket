from __future__ import annotations

import typer

from docket._console import console
from docket.cli.context import prepare_or_wizard
from docket.core.services import sync_service


def sync_command(
    full: bool = typer.Option(
        False, "--full", help="Reset watermark and resync everything the provider exposes."
    ),
    provider: str | None = typer.Option(
        None, "--provider", help="Provider id to sync (defaults to config.active_provider)."
    ),
) -> None:
    """Refresh the local cache from the active work-item provider.

    Sync always pulls everything the provider exposes; the `--scope` /
    view picker is a post-cache visual filter."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        if provider_key and provider_key != ctx.active_provider:
            ctx.active_provider = provider_key
        with console.status(f"Syncing from '{provider_key}'..."):
            fn = sync_service.full_refresh if full else sync_service.refresh
            summary = fn(ctx.conn, ctx.provider, provider_key=provider_key)
        console.print(
            f"[green]✓[/green] synced {summary.upserted} item(s), "
            f"archived {summary.archived}, watermark → {summary.watermark}"
        )
