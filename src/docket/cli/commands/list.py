from __future__ import annotations

import typer
from rich.table import Table

from docket._console import console
from docket.cli.context import prepare_or_wizard
from docket.core.model import ItemKind
from docket.core.services import visual_filter
from docket.providers import registry
from docket.storage.repos import item_repo


def list_command(
    kind: str | None = typer.Option(
        None, "--kind", help="Filter by kind: epic, feature, story, task, bug."
    ),
    show_archived: bool = typer.Option(False, "--archived", help="Include archived items."),
) -> None:
    """List items from the local cache."""
    with prepare_or_wizard() as ctx:
        kind_filter = ItemKind(kind) if kind else None
        spec = registry.spec(ctx.config.providers[ctx.active_provider].type)
        resolved = visual_filter.resolve(ctx.view_filters(), ctx.provider, spec)
        items = item_repo.list_items(
            ctx.conn,
            kind=kind_filter,
            include_archived=show_archived,
            provider_key=ctx.active_provider or None,
        )
        items = visual_filter.apply_to_items(items, resolved)
        table = Table(title=f"Docket ({len(items)} items)")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Kind", style="magenta")
        table.add_column("State")
        table.add_column("Assignee")
        table.add_column("Title")
        for it in items:
            table.add_row(it.id, it.kind.value, it.state.value, it.assignee or "—", it.title)
        console.print(table)
