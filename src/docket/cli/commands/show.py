from __future__ import annotations

import typer
from rich.markdown import Markdown
from rich.panel import Panel

from docket._console import console
from docket.cli.context import prepare_or_wizard
from docket.storage.repos import comment_repo, item_repo


def show_command(id: str = typer.Argument(..., help="Work item ID.")) -> None:
    """Show a single item's detail from the local cache."""
    with prepare_or_wizard() as ctx:
        item = item_repo.get_item(ctx.conn, id, provider_key=ctx.active_provider or None)
        if item is None:
            console.print(f"[red]No cached item with id={id}.[/red] Try `docket sync`.")
            raise typer.Exit(code=1)
        header = (
            f"[bold]{item.title}[/bold]\n"
            f"id={item.id}  kind={item.kind.value}  state={item.state.value}  "
            f"assignee={item.assignee or '—'}  tags={', '.join(item.tags) or '—'}"
        )
        console.print(Panel.fit(header, title=f"Docket {item.id}"))
        if item.description_md.strip():
            console.print(Markdown(item.description_md))
        comments = comment_repo.list_comments(
            ctx.conn, id, provider_key=ctx.active_provider or None
        )
        if comments:
            console.print("\n[bold]Comments[/bold]")
            for c in comments:
                console.print(f"[dim]{c.created_at.isoformat()}  {c.author}[/dim]")
                console.print(Markdown(c.body_md))
