from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from docket.cli.commands._utils import DryRun
from docket.cli.confirm import apply_mutation
from docket.cli.context import prepare_or_wizard
from docket.cli.guard import abort_if_read_only
from docket.core.mutation import DescriptionPatch
from docket.core.services import mutation_service

console = Console()


def patch_command(
    id: str = typer.Argument(..., help="Work item ID."),
    from_file: Path = typer.Option(
        ..., "--from-file", help="Path to Markdown file with the new description."
    ),
    dry_run: DryRun = False,
) -> None:
    """Replace a work item's description with the contents of a Markdown file."""
    abort_if_read_only(console)
    try:
        new_md = from_file.read_text(encoding="utf-8")
    except OSError as exc:
        console.print(f"[red]Cannot read {from_file}: {exc}[/red]")
        raise typer.Exit(2) from exc

    with prepare_or_wizard() as ctx:
        item = mutation_service.require_cached_item(ctx.conn, id, provider_key=ctx.active_provider)
        proposal = DescriptionPatch(item=item, new_md=new_md)
        apply_mutation(
            ctx.conn,
            ctx.provider,
            proposal,
            confirm_title=f"Patch description of {id}",
            dry_run=dry_run,
            on_success=lambda _r: f"[green]✓ {id} description updated[/green]",
            provider_key=ctx.active_provider,
        )
