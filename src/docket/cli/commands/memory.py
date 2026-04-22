"""`docket memory ...` — manage per-project agent memory.

Memory entries are scoped to the active project. They're plain Markdown so
a human can read and edit them; the agent reads them through `list_memory`
and `recall_memory` tools and writes them through proposal-confirm.
"""

from __future__ import annotations

import sys
from datetime import datetime

import typer
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table

from docket.cli.context import Context, prepare_or_wizard
from docket.core.model import MemoryEntry
from docket.core.services import memory_service

console = Console()

memory_app = typer.Typer(
    name="memory",
    help="List, search, add, edit, remove project memory entries.",
    no_args_is_help=True,
)


def _split_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


def _format_updated(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%Y-%m-%d %H:%M")


def _read_body(body: str | None, from_file: str | None) -> str:
    if from_file == "-":
        return sys.stdin.read()
    if from_file:
        with open(from_file, encoding="utf-8") as fh:
            return fh.read()
    if body is not None:
        return body
    raise typer.BadParameter("provide --body or --from-file (use '-' for stdin)")


@memory_app.command("list")
def memory_list(
    limit: int = typer.Option(50, "--limit", min=1, max=500, help="Max entries to show."),
) -> None:
    """List memory entries for the active project (most recent first)."""
    ctx = prepare_or_wizard()
    try:
        # Ensure the project row exists so the command works on a fresh DB
        # before any memory has been written.
        project = ctx.active_project()
        rows = memory_service.list_entries(ctx.conn, project.id, limit=limit)
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
                _format_updated(entry.updated_at),
            )
        console.print(table)
    finally:
        ctx.close()


@memory_app.command("show")
def memory_show(
    memory_id: str = typer.Argument(..., help="Memory id (full or 8-char prefix)."),
) -> None:
    """Show one memory entry in full."""
    ctx = prepare_or_wizard()
    try:
        entry = _resolve(ctx, memory_id)
        meta = (
            f"[bold cyan]{entry.title}[/bold cyan]\n"
            f"[dim]id:[/dim] {entry.id}    "
            f"[dim]source:[/dim] {entry.source}    "
            f"[dim]updated:[/dim] {_format_updated(entry.updated_at)}\n"
            f"[dim]tags:[/dim] {', '.join(entry.tags) or '—'}"
        )
        console.print(Panel.fit(meta, border_style="cyan"))
        console.print(Markdown(entry.body_md or "*(empty)*"))
    finally:
        ctx.close()


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
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        body_md = _read_body(body, from_file)
        entry = memory_service.add_entry(
            ctx.conn,
            project_id=project.id,
            title=title,
            body_md=body_md,
            tags=_split_tags(tags),
            source="user",
        )
        console.print(
            f"[green]Added[/green] memory [cyan]{entry.title}[/cyan] "
            f"[dim]({entry.id[:8]})[/dim] to [cyan]{project.name}[/cyan]."
        )
    finally:
        ctx.close()


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
    ctx = prepare_or_wizard()
    try:
        existing = _resolve(ctx, memory_id)
        body_md: str | None = (
            _read_body(body, from_file) if body is not None or from_file is not None else None
        )
        if title is None and body_md is None and tags is None:
            console.print("[yellow]Nothing to update[/yellow] — pass --title, --body, or --tags.")
            raise typer.Exit(2)
        updated = memory_service.edit_entry(
            ctx.conn,
            existing.id,
            title=title,
            body_md=body_md,
            tags=_split_tags(tags) if tags is not None else None,
        )
        if updated is None:
            console.print(f"[red]Memory entry vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(
            f"[green]Updated[/green] memory [cyan]{updated.title}[/cyan] "
            f"[dim]({updated.id[:8]})[/dim]."
        )
    finally:
        ctx.close()


@memory_app.command("rm")
def memory_rm(
    memory_id: str = typer.Argument(..., help="Memory id (full or 8-char prefix)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),
) -> None:
    """Remove a memory entry."""
    ctx = prepare_or_wizard()
    try:
        existing = _resolve(ctx, memory_id)
        if not yes:
            confirmed = typer.confirm(
                f"Delete memory '{existing.title}' ({existing.id[:8]})?", default=False
            )
            if not confirmed:
                console.print("[dim]Cancelled.[/dim]")
                raise typer.Exit(1)
        ok = memory_service.remove_entry(ctx.conn, existing.id)
        if not ok:
            console.print(f"[red]Memory entry vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(f"[yellow]Removed[/yellow] memory [dim]({existing.id[:8]})[/dim].")
    finally:
        ctx.close()


@memory_app.command("search")
def memory_search(
    query: str = typer.Argument(..., help="Full-text search query."),
    limit: int = typer.Option(20, "--limit", min=1, max=100),
) -> None:
    """Search the active project's memory (FTS5, best-match first)."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        rows = memory_service.search_entries(ctx.conn, project.id, query, limit=limit)
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
                _format_updated(entry.updated_at),
            )
        console.print(table)
    finally:
        ctx.close()


def _resolve(ctx: Context, memory_id: str) -> MemoryEntry:
    """Look up by full id; on miss, fall back to a unique 8-char prefix match."""
    direct = memory_service.get_entry(ctx.conn, memory_id)
    if direct is not None:
        return direct
    project = ctx.active_project()
    candidates = [
        e for e in memory_service.list_entries(ctx.conn, project.id) if e.id.startswith(memory_id)
    ]
    if not candidates:
        console.print(f"[red]No memory entry matching:[/red] {memory_id}")
        raise typer.Exit(1)
    if len(candidates) > 1:
        console.print(
            f"[red]Ambiguous prefix '{memory_id}' matches {len(candidates)} entries.[/red]"
        )
        for entry in candidates[:5]:
            console.print(f"  [dim]{entry.id}[/dim]  {entry.title}")
        raise typer.Exit(1)
    return candidates[0]


__all__ = ["memory_app"]
