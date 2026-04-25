"""`docket memory ...` — manage per-project agent memory.

Memory entries are scoped to the active project. They're plain Markdown so
a human can read and edit them; the agent reads them through `list_memory`
and `recall_memory` tools and writes them through proposal-confirm.
"""

from __future__ import annotations

import typer
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from docket.cli._console import console
from docket.cli.commands._utils import (
    format_updated,
    read_body,
    resolve_by_id_or_prefix,
    split_tags,
)
from docket.cli.context import Context, prepare_or_wizard
from docket.core.model import MemoryEntry
from docket.storage.repos import memory_repo

memory_app = typer.Typer(
    name="memory",
    help="List, search, add, edit, remove project memory entries.",
    no_args_is_help=True,
)


@memory_app.command("list")
def memory_list(
    limit: int = typer.Option(50, "--limit", min=1, max=500, help="Max entries to show."),
) -> None:
    """List memory entries for the active project (most recent first)."""
    with prepare_or_wizard() as ctx:
        # Ensure the project row exists so the command works on a fresh DB
        # before any memory has been written.
        project = ctx.active_project()
        rows = memory_repo.list_for_project(ctx.conn, project.id, limit=limit)
        if not rows:
            console.print(
                f"[dim]No memory entries for[/dim] [cyan]{project.name}[/cyan] "
                "[dim](try `docket memory add`)[/dim]"
            )
            return
        table = Table(title=f"Memory · {project.name} ({len(rows)})")
        table.add_column("Id", style="dim", no_wrap=True)
        table.add_column("Title", style="cyan")
        table.add_column("Tags", style="yellow")
        table.add_column("Source", style="magenta")
        table.add_column("Updated", style="green")
        for entry in rows:
            table.add_row(
                entry.id[:8],
                entry.title,
                ", ".join(entry.tags),
                entry.source,
                format_updated(entry.updated_at),
            )
        console.print(table)


@memory_app.command("show")
def memory_show(
    memory_id: str = typer.Argument(..., help="Memory id (full or 8-char prefix)."),
) -> None:
    """Show one memory entry in full."""
    with prepare_or_wizard() as ctx:
        entry = _resolve(ctx, memory_id)
        meta = (
            f"[bold cyan]{entry.title}[/bold cyan]\n"
            f"[dim]id:[/dim] {entry.id}    "
            f"[dim]source:[/dim] {entry.source}    "
            f"[dim]updated:[/dim] {format_updated(entry.updated_at)}\n"
            f"[dim]tags:[/dim] {', '.join(entry.tags) or '—'}"
        )
        console.print(Panel.fit(meta, border_style="cyan"))
        console.print(Markdown(entry.body_md or "*(empty)*"))


@memory_app.command("add")
def memory_add(
    title: str = typer.Argument(..., help="Title for the memory entry."),
    body: str | None = typer.Option(None, "--body", help="Markdown body inline."),
    from_file: str | None = typer.Option(
        None, "--from-file", help="Read body from file ('-' for stdin)."
    ),
    tags: str | None = typer.Option(None, "--tags", help="Comma-separated tags."),
) -> None:
    """Add a new memory entry to the active project (source=user)."""
    with prepare_or_wizard() as ctx:
        project = ctx.active_project()
        body_md = read_body(body, from_file)
        entry = memory_repo.create(
            ctx.conn,
            project_id=project.id,
            title=title,
            body_md=body_md,
            tags=split_tags(tags),
            source="user",
        )
        console.print(
            f"[green]Added[/green] memory [cyan]{entry.title}[/cyan] "
            f"[dim]({entry.id[:8]})[/dim] to [cyan]{project.name}[/cyan]."
        )


@memory_app.command("edit")
def memory_edit(
    memory_id: str = typer.Argument(..., help="Memory id (full or 8-char prefix)."),
    title: str | None = typer.Option(None, "--title", help="New title."),
    body: str | None = typer.Option(None, "--body", help="New body inline."),
    from_file: str | None = typer.Option(
        None, "--from-file", help="Read body from file ('-' for stdin)."
    ),
    tags: str | None = typer.Option(
        None, "--tags", help="Replace tags with this comma-separated list."
    ),
) -> None:
    """Edit an existing memory entry. Pass any of --title, --body, --tags."""
    with prepare_or_wizard() as ctx:
        existing = _resolve(ctx, memory_id)
        body_md: str | None = (
            read_body(body, from_file) if body is not None or from_file is not None else None
        )
        if title is None and body_md is None and tags is None:
            console.print("[yellow]Nothing to update[/yellow] — pass --title, --body, or --tags.")
            raise typer.Exit(2)
        updated = memory_repo.update(
            ctx.conn,
            existing.id,
            title=title,
            body_md=body_md,
            tags=split_tags(tags) if tags is not None else None,
        )
        if updated is None:
            console.print(f"[red]Memory entry vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(
            f"[green]Updated[/green] memory [cyan]{updated.title}[/cyan] "
            f"[dim]({updated.id[:8]})[/dim]."
        )


@memory_app.command("rm")
def memory_rm(
    memory_id: str = typer.Argument(..., help="Memory id (full or 8-char prefix)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),
) -> None:
    """Remove a memory entry."""
    with prepare_or_wizard() as ctx:
        existing = _resolve(ctx, memory_id)
        if not yes:
            confirmed = typer.confirm(
                f"Delete memory '{existing.title}' ({existing.id[:8]})?", default=False
            )
            if not confirmed:
                console.print("[dim]Cancelled.[/dim]")
                raise typer.Exit(1)
        ok = memory_repo.delete(ctx.conn, existing.id)
        if not ok:
            console.print(f"[red]Memory entry vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(f"[yellow]Removed[/yellow] memory [dim]({existing.id[:8]})[/dim].")


@memory_app.command("search")
def memory_search(
    query: str = typer.Argument(..., help="Full-text search query."),
    limit: int = typer.Option(20, "--limit", min=1, max=100),
) -> None:
    """Search the active project's memory (FTS5, best-match first)."""
    with prepare_or_wizard() as ctx:
        project = ctx.active_project()
        rows = memory_repo.search(ctx.conn, project.id, query, limit=limit)
        if not rows:
            console.print(f"[dim]No matches in[/dim] [cyan]{project.name}[/cyan].")
            return
        table = Table(title=f"Memory search · {project.name} ({len(rows)})")
        table.add_column("Id", style="dim", no_wrap=True)
        table.add_column("Title", style="cyan")
        table.add_column("Tags", style="yellow")
        table.add_column("Updated", style="green")
        for entry in rows:
            table.add_row(
                entry.id[:8],
                entry.title,
                ", ".join(entry.tags),
                format_updated(entry.updated_at),
            )
        console.print(table)


def _resolve(ctx: Context, memory_id: str) -> MemoryEntry:
    project = ctx.active_project()
    return resolve_by_id_or_prefix(
        memory_id,
        get_fn=lambda mid: memory_repo.get(ctx.conn, mid),
        candidates_fn=lambda: memory_repo.list_for_project(ctx.conn, project.id),
        resource_name="memory entry",
        console=console,
    )


__all__ = ["memory_app"]
