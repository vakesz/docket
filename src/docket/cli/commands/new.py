from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from docket.cli.confirm import prompt_confirm
from docket.cli.context import prepare_or_wizard
from docket.core.model import CreateFields, ItemKind
from docket.core.services import mutation_service

console = Console()

_KIND_HELP = f"Kind: {', '.join(k.value for k in ItemKind)}"


def new_command(
    kind: str = typer.Argument(..., help=_KIND_HELP),
    title: str = typer.Option(..., "--title", help="Item title (required)."),
    description_file: Path | None = typer.Option(
        None, "--description-file", help="Optional path to a Markdown description."
    ),
    parent_id: str | None = typer.Option(None, "--parent", help="Parent work item ID."),
    assignee: str | None = typer.Option(None, "--assignee", help="Assignee (email)."),
    tags: str | None = typer.Option(None, "--tags", help="Comma-separated tags."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Show preview, do not create."),
) -> None:
    """Create a new work item."""
    try:
        ik = ItemKind(kind)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(2) from e
    fields = CreateFields(
        title=title,
        description_md=description_file.read_text(encoding="utf-8") if description_file else "",
        parent_id=parent_id,
        assignee=assignee,
        tags=[t.strip() for t in tags.split(",")] if tags else [],
    )

    ctx = prepare_or_wizard()
    try:
        proposal = mutation_service.propose_create(ik, fields)
        if dry_run:
            result = mutation_service.confirm(ctx.conn, ctx.provider, proposal, dry_run=True)
            console.print(f"[dim]dry-run — would create (proposal {result.proposal_id})[/dim]")
            return
        if not prompt_confirm(proposal, title=f"Create {ik.value}"):
            console.print("[yellow]cancelled[/yellow]")
            raise typer.Exit(1)
        result = mutation_service.confirm(ctx.conn, ctx.provider, proposal)
        assert result.item is not None
        console.print(f"[green]✓ created[/green] {result.item.id}  {result.item.title}")
    finally:
        ctx.close()
