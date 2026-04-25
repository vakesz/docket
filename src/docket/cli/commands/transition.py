from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.commands._utils import DryRun
from docket.cli.confirm import apply_mutation
from docket.cli.context import prepare_or_wizard
from docket.cli.guard import abort_if_read_only
from docket.core.model import TransitionIntent
from docket.core.mutation import StateChange
from docket.core.services import mutation_service

console = Console()

_INTENT_HELP = f"Transition intent: {', '.join(i.value for i in TransitionIntent)}"


def transition_command(
    id: str = typer.Argument(..., help="Work item ID."),
    intent: str = typer.Argument(..., help=_INTENT_HELP),
    dry_run: DryRun = False,
) -> None:
    """Move a work item to a new state using a named intent."""
    abort_if_read_only(console)
    try:
        ti = TransitionIntent(intent)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(2) from e

    with prepare_or_wizard() as ctx:
        item = mutation_service.require_cached_item(ctx.conn, id, provider_key=ctx.active_provider)
        proposal = StateChange(item=item, intent=ti)
        apply_mutation(
            ctx.conn,
            ctx.provider,
            proposal,
            confirm_title=f"Transition {id} ({ti.value})",
            dry_run=dry_run,
            on_success=lambda r: f"[green]✓ {id} → {r.item.state.value}[/green]",  # type: ignore[union-attr]
            provider_key=ctx.active_provider,
        )
