"""`docket project ...` — manage named provider projects.

Project metadata (name, description, archive flag) lives in `config.toml`.
The active project is whichever provider is active; scopes are visual
filters on top and don't create separate projects.
"""

from __future__ import annotations

import typer
from rich.table import Table

from docket._console import console
from docket.cli.context import prepare_or_wizard
from docket.core.model import project_id_for
from docket.core.services import project_service
from docket.storage.repos import project_repo

project_app = typer.Typer(
    name="project",
    help="List, rename, describe, archive named projects (one per provider).",
    no_args_is_help=True,
)


@project_app.command("list")
def project_list(
    show_archived: bool = typer.Option(False, "--archived", help="Include archived projects."),
) -> None:
    """List configured projects from config.toml."""
    with prepare_or_wizard() as ctx:
        active_id = ctx.project_id
        rows = project_repo.list_all(ctx.conn, include_archived=show_archived)
        table = Table(title=f"Projects ({len(rows)})")
        table.add_column("Active", style="green")
        table.add_column("Name", style="cyan")
        table.add_column("Provider", style="magenta")
        table.add_column("Description")
        table.add_column("Archived", style="dim")
        for project in rows:
            table.add_row(
                "●" if project.id == active_id else "",
                project.name,
                project.provider_key or "—",
                project.description or "",
                "yes" if project.archived_at else "",
            )
        console.print(table)
        console.print(
            "[dim]Tip:[/dim] switch projects by switching provider: "
            "`docket setup` or the TUI provider picker (Ctrl+P)."
        )


@project_app.command("show")
def project_show(
    provider: str | None = typer.Option(
        None, "--provider", help="Provider key (defaults to active provider)."
    ),
) -> None:
    """Show one project's metadata."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        project = project_repo.get(ctx.conn, project_id_for(provider_key))
        if project is None:
            console.print(
                f"[yellow]No project metadata for[/yellow] "
                f"{provider_key} (run `docket project rename` to create)."
            )
            raise typer.Exit(1)
        console.print(f"[bold cyan]{project.name}[/bold cyan]")
        console.print(f"[dim]id:[/dim]          {project.id}")
        console.print(f"[dim]provider:[/dim]    {project.provider_key}")
        console.print(f"[dim]description:[/dim] {project.description or '—'}")
        if project.archived_at:
            console.print(f"[red]archived at:[/red] {project.archived_at.isoformat()}")


@project_app.command("rename")
def project_rename(
    name: str = typer.Argument(..., help="New display name."),
    provider: str | None = typer.Option(
        None, "--provider", help="Provider key (defaults to active provider)."
    ),
) -> None:
    """Rename the project for `provider`. Persists to config.toml."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        project = project_service.upsert(
            ctx.config,
            ctx.paths,
            ctx.conn,
            provider_key=provider_key,
            name=name,
        )
        console.print(
            f"[green]Renamed[/green] {project.id} → [cyan]{project.name}[/cyan] "
            "(saved to config.toml)."
        )


@project_app.command("describe")
def project_describe(
    description: str = typer.Argument(..., help="Project description."),
    provider: str | None = typer.Option(
        None, "--provider", help="Provider key (defaults to active provider)."
    ),
) -> None:
    """Set the description on the project for `provider`."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        project = project_service.upsert(
            ctx.config,
            ctx.paths,
            ctx.conn,
            provider_key=provider_key,
            description=description,
        )
        console.print(
            f"[green]Updated[/green] description for [cyan]{project.name}[/cyan] "
            "(saved to config.toml)."
        )


@project_app.command("archive")
def project_archive(
    provider: str | None = typer.Option(
        None, "--provider", help="Provider key (defaults to active provider)."
    ),
) -> None:
    """Mark a project as archived (hidden from default lists)."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        project_id = project_id_for(provider_key)
        project_service.archive(ctx.config, ctx.paths, ctx.conn, project_id)
        console.print(f"[yellow]Archived[/yellow] {project_id}.")


@project_app.command("unarchive")
def project_unarchive(
    provider: str | None = typer.Option(None, "--provider", help="Provider key."),
) -> None:
    """Restore an archived project."""
    with prepare_or_wizard() as ctx:
        provider_key = provider or ctx.active_provider
        project_id = project_id_for(provider_key)
        project_service.unarchive(ctx.config, ctx.paths, ctx.conn, project_id)
        console.print(f"[green]Unarchived[/green] {project_id}.")


__all__ = ["project_app"]
