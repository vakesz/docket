"""`docket source ...` — manage per-project reference documents.

Sources are scoped to the active project. They're plain Markdown so a
human can read and edit them; the agent reads them through `list_sources`,
`read_source`, and `search_sources` tools but cannot write — sources are
human-curated reference material (requirements, design notes, runbooks).
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
from docket.core.model import Source
from docket.storage.repos import source_repo

console = Console()

source_app = typer.Typer(
    name="source",
    help="List, search, add, edit, remove project source documents.",
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


@source_app.command("list")
def source_list(
    kind: str | None = typer.Option(None, "--kind", help="Filter by kind."),
    limit: int = typer.Option(50, "--limit", min=1, max=500, help="Max entries to show."),
) -> None:
    """List source documents for the active project (most recent first)."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        rows = source_repo.list_for_project(ctx.conn, project.id, kind=kind, limit=limit)
        if not rows:
            console.print(
                f"[dim]No source documents for[/dim] [cyan]{project.name}[/cyan] "
                "[dim](try `docket source add`)[/dim]"
            )
            return
        table = Table(title=f"Sources · {project.name} ({len(rows)})")
        table.add_column("Id", style="dim", no_wrap=True)
        table.add_column("Title", style="cyan")
        table.add_column("Kind", style="magenta")
        table.add_column("Tags", style="yellow")
        table.add_column("Updated", style="green")
        for entry in rows:
            table.add_row(
                entry.id[:8],
                entry.title,
                entry.kind or "—",
                ", ".join(entry.tags),
                _format_updated(entry.updated_at),
            )
        console.print(table)
    finally:
        ctx.close()


@source_app.command("show")
def source_show(
    source_id: str = typer.Argument(..., help="Source id (full or 8-char prefix)."),
) -> None:
    """Show one source document in full."""
    ctx = prepare_or_wizard()
    try:
        entry = _resolve(ctx, source_id)
        meta = (
            f"[bold cyan]{entry.title}[/bold cyan]\n"
            f"[dim]id:[/dim] {entry.id}    "
            f"[dim]kind:[/dim] {entry.kind or '—'}    "
            f"[dim]updated:[/dim] {_format_updated(entry.updated_at)}\n"
            f"[dim]uri:[/dim] {entry.uri or '—'}\n"
            f"[dim]tags:[/dim] {', '.join(entry.tags) or '—'}"
        )
        console.print(Panel.fit(meta, border_style="cyan"))
        console.print(Markdown(entry.body_md or "*(empty)*"))
    finally:
        ctx.close()


@source_app.command("add")
def source_add(
    title: str = typer.Argument(..., help="Title for the source document."),
    body: str | None = typer.Option(None, "--body", help="Markdown body inline."),
    from_file: str | None = typer.Option(
        None, "--from-file", help="Read body from file ('-' for stdin)."
    ),
    kind: str = typer.Option("", "--kind", help="Free-text category (e.g. 'requirements')."),
    uri: str = typer.Option("", "--uri", help="Optional reference URL or path."),
    tags: str | None = typer.Option(None, "--tags", help="Comma-separated tags."),
) -> None:
    """Add a new source document to the active project."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        body_md = _read_body(body, from_file)
        entry = source_repo.create(
            ctx.conn,
            project_id=project.id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=_split_tags(tags),
        )
        console.print(
            f"[green]Added[/green] source [cyan]{entry.title}[/cyan] "
            f"[dim]({entry.id[:8]})[/dim] to [cyan]{project.name}[/cyan]."
        )
    finally:
        ctx.close()


@source_app.command("edit")
def source_edit(
    source_id: str = typer.Argument(..., help="Source id (full or 8-char prefix)."),
    title: str | None = typer.Option(None, "--title", help="New title."),
    body: str | None = typer.Option(None, "--body", help="New body inline."),
    from_file: str | None = typer.Option(
        None, "--from-file", help="Read body from file ('-' for stdin)."
    ),
    kind: str | None = typer.Option(None, "--kind", help="Replace kind."),
    uri: str | None = typer.Option(None, "--uri", help="Replace uri."),
    tags: str | None = typer.Option(
        None, "--tags", help="Replace tags with this comma-separated list."
    ),
) -> None:
    """Edit an existing source document. Pass any of --title, --body, --kind, --uri, --tags."""
    ctx = prepare_or_wizard()
    try:
        existing = _resolve(ctx, source_id)
        body_md: str | None = (
            _read_body(body, from_file) if body is not None or from_file is not None else None
        )
        if title is None and body_md is None and kind is None and uri is None and tags is None:
            console.print(
                "[yellow]Nothing to update[/yellow] — pass --title, --body, --kind, --uri, or --tags."
            )
            raise typer.Exit(2)
        updated = source_repo.update(
            ctx.conn,
            existing.id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=_split_tags(tags) if tags is not None else None,
        )
        if updated is None:
            console.print(f"[red]Source vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(
            f"[green]Updated[/green] source [cyan]{updated.title}[/cyan] "
            f"[dim]({updated.id[:8]})[/dim]."
        )
    finally:
        ctx.close()


@source_app.command("rm")
def source_rm(
    source_id: str = typer.Argument(..., help="Source id (full or 8-char prefix)."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),
) -> None:
    """Remove a source document."""
    ctx = prepare_or_wizard()
    try:
        existing = _resolve(ctx, source_id)
        if not yes:
            confirmed = typer.confirm(
                f"Delete source '{existing.title}' ({existing.id[:8]})?", default=False
            )
            if not confirmed:
                console.print("[dim]Cancelled.[/dim]")
                raise typer.Exit(1)
        ok = source_repo.delete(ctx.conn, existing.id)
        if not ok:
            console.print(f"[red]Source vanished:[/red] {existing.id}")
            raise typer.Exit(1)
        console.print(f"[yellow]Removed[/yellow] source [dim]({existing.id[:8]})[/dim].")
    finally:
        ctx.close()


@source_app.command("search")
def source_search(
    query: str = typer.Argument(..., help="Full-text search query."),
    kind: str | None = typer.Option(None, "--kind", help="Filter by kind."),
    limit: int = typer.Option(20, "--limit", min=1, max=100),
) -> None:
    """Search the active project's sources (FTS5, best-match first)."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        rows = source_repo.search(ctx.conn, project.id, query, kind=kind, limit=limit)
        if not rows:
            console.print(f"[dim]No matches in[/dim] [cyan]{project.name}[/cyan].")
            return
        table = Table(title=f"Source search · {project.name} ({len(rows)})")
        table.add_column("Id", style="dim", no_wrap=True)
        table.add_column("Title", style="cyan")
        table.add_column("Kind", style="magenta")
        table.add_column("Tags", style="yellow")
        table.add_column("Updated", style="green")
        for entry in rows:
            table.add_row(
                entry.id[:8],
                entry.title,
                entry.kind or "—",
                ", ".join(entry.tags),
                _format_updated(entry.updated_at),
            )
        console.print(table)
    finally:
        ctx.close()


def _resolve(ctx: Context, source_id: str) -> Source:
    """Look up by full id; on miss, fall back to a unique 8-char prefix match."""
    direct = source_repo.get(ctx.conn, source_id)
    if direct is not None:
        return direct
    project = ctx.active_project()
    candidates = [
        e for e in source_repo.list_for_project(ctx.conn, project.id) if e.id.startswith(source_id)
    ]
    if not candidates:
        console.print(f"[red]No source matching:[/red] {source_id}")
        raise typer.Exit(1)
    if len(candidates) > 1:
        console.print(
            f"[red]Ambiguous prefix '{source_id}' matches {len(candidates)} sources.[/red]"
        )
        for entry in candidates[:5]:
            console.print(f"  [dim]{entry.id}[/dim]  {entry.title}")
        raise typer.Exit(1)
    return candidates[0]


__all__ = ["source_app"]
