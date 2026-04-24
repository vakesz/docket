from __future__ import annotations

from pathlib import Path

import typer
from rich.console import Console

from docket.cli.confirm import apply_mutation
from docket.cli.context import prepare_or_wizard
from docket.cli.guard import abort_if_read_only
from docket.core.model import CreateFields, ItemKind
from docket.core.mutation import ItemCreate

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
    abort_if_read_only(console)
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
        proposal = ItemCreate(item_kind=ik, fields=fields)
        apply_mutation(
            ctx.conn,
            ctx.provider,
            proposal,
            confirm_title=f"Create {ik.value}",
            dry_run=dry_run,
            on_success=lambda r: f"[green]✓ created[/green] {r.item.id}  {r.item.title}",  # type: ignore[union-attr]
            provider_key=ctx.active_provider,
        )
    finally:
        ctx.close()
