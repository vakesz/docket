from __future__ import annotations

from pathlib import Path

import typer

from docket._console import console
from docket.cli.commands._utils import DryRun, enum_from_arg
from docket.cli.confirm import apply_mutation
from docket.cli.context import prepare_or_wizard
from docket.cli.guard import abort_if_read_only
from docket.core.model import CreateFields, ItemKind
from docket.core.mutation import ItemCreate

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
    dry_run: DryRun = False,
) -> None:
    """Create a new work item."""
    ik = enum_from_arg(kind, ItemKind, "kind")
    fields = CreateFields(
        title=title,
        description_md=description_file.read_text(encoding="utf-8") if description_file else "",
        parent_id=parent_id,
        assignee=assignee,
        tags=[t.strip() for t in tags.split(",")] if tags else [],
    )

    with prepare_or_wizard() as ctx:
        abort_if_read_only(console, ctx.config)
        proposal = ItemCreate(item_kind=ik, fields=fields)
        apply_mutation(
            ctx.conn,
            ctx.provider,
            proposal,
            confirm_title=f"Create {ik.value}",
            dry_run=dry_run,
            on_success=lambda r: (
                f"[green]✓ created[/green] {r.require_item().id}  {r.require_item().title}"
            ),
            provider_key=ctx.active_provider,
        )
