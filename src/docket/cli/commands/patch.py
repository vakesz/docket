from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from docket.cli.confirm import prompt_confirm
from docket.cli.context import prepare_or_wizard
from docket.cli.guard import abort_if_read_only
from docket.core.services import mutation_service

console = Console()


def patch_command(
    id: str = typer.Argument(..., help="Work item ID."),
    from_file: Path = typer.Option(
        ..., "--from-file", help="Path to Markdown file with the new description."
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show diff, do not write."),
) -> None:
    """Replace a work item's description with the contents of a Markdown file."""
    abort_if_read_only(console)
    if not from_file.exists():
        console.print(f"[red]File not found: {from_file}[/red]")
        raise typer.Exit(2)
    new_md = from_file.read_text(encoding="utf-8")

    ctx = prepare_or_wizard()
    try:
        proposal = mutation_service.propose_description_patch(ctx.conn, id, new_md)
        if dry_run:
            result = mutation_service.confirm(ctx.conn, ctx.provider, proposal, dry_run=True)
            console.print(f"[dim]dry-run — would apply proposal {result.proposal_id}[/dim]")
            return
        if not prompt_confirm(proposal, title=f"Patch description of {id}"):
            console.print("[yellow]cancelled[/yellow]")
            raise typer.Exit(1)
        result = mutation_service.confirm(ctx.conn, ctx.provider, proposal)
        assert result.item is not None
        console.print(f"[green]✓ {id} description updated[/green]")
    finally:
        ctx.close()
