from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.confirm import prompt_confirm
from docket.cli.context import prepare_or_wizard
from docket.core.model import TransitionIntent
from docket.core.services import mutation_service

console = Console()

_INTENT_HELP = f"Transition intent: {', '.join(i.value for i in TransitionIntent)}"


def transition_command(
    id: str = typer.Argument(..., help="Work item ID."),
    intent: str = typer.Argument(..., help=_INTENT_HELP),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show diff, do not write."),
) -> None:
    """Move a work item to a new state using a named intent."""
    try:
        ti = TransitionIntent(intent)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(2) from e

    ctx = prepare_or_wizard()
    try:
        proposal = mutation_service.propose_transition(ctx.conn, id, ti)
        if dry_run:
            result = mutation_service.confirm(ctx.conn, ctx.provider, proposal, dry_run=True)
            console.print(f"[dim]dry-run — would apply proposal {result.proposal_id}[/dim]")
            return
        if not prompt_confirm(proposal, title=f"Transition {id} ({ti.value})"):
            console.print("[yellow]cancelled[/yellow]")
            raise typer.Exit(1)
        result = mutation_service.confirm(ctx.conn, ctx.provider, proposal)
        assert result.item is not None
        console.print(f"[green]✓ {id} → {result.item.state.value}[/green]")
    finally:
        ctx.close()
