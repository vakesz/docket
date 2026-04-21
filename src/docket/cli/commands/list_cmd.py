from __future__ import annotations

import typer
from rich.console import Console
from rich.table import Table

from docket.cli.context import prepare_or_wizard
from docket.core.model import ItemKind
from docket.storage.repos import item_repo

console = Console()


def list_command(
    kind: str | None = typer.Option(None, "--kind", help="Filter by kind: epic, feature, story, task, bug."),
    show_archived: bool = typer.Option(False, "--archived", help="Include archived items."),
) -> None:
    """List items from the local cache."""
    ctx = prepare_or_wizard()
    try:
        kind_filter = ItemKind(kind) if kind else None
        items = item_repo.list_items(ctx.conn, kind=kind_filter, include_archived=show_archived)
        table = Table(title=f"Docket ({len(items)} items)")
        table.add_column("ID", style="cyan", no_wrap=True)
        table.add_column("Kind", style="magenta")
        table.add_column("State")
        table.add_column("Assignee")
        table.add_column("Title")
        for it in items:
            table.add_row(it.id, it.kind.value, it.state.value, it.assignee or "—", it.title)
        console.print(table)
    finally:
        ctx.close()
