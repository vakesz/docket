from __future__ import annotations

from dataclasses import dataclass

import typer
from rich.console import Console
from rich.table import Table

console = Console()


@dataclass(frozen=True)
class CommandHelp:
    name: str
    summary: str
    usage: str


COMMANDS: tuple[CommandHelp, ...] = (
    CommandHelp("open", "Open the Textual interface.", "docket"),
    CommandHelp("sync", "Refresh the local cache from the provider.", "docket sync"),
    CommandHelp("list", "List cached items.", "docket list --kind story"),
    CommandHelp("show", "Show one cached item in detail.", "docket show S-42"),
    CommandHelp(
        "new",
        "Create a new work item with a confirm step.",
        'docket new task --title "Triage bug"',
    ),
    CommandHelp(
        "transition",
        "Move an item using a named transition intent.",
        "docket transition S-42 start_work --dry-run",
    ),
    CommandHelp(
        "patch",
        "Preview and apply a Markdown description update.",
        "docket patch S-42 --from-file body.md --dry-run",
    ),
    CommandHelp("serve", "Run the local HTTP API surface.", "docket serve"),
    CommandHelp("setup", "Run or resume first-time setup.", "docket setup"),
    CommandHelp(
        "project",
        "List, rename, describe, archive named projects.",
        "docket project list",
    ),
    CommandHelp("help", "Show commands and examples.", "docket help"),
)


def help_command(
    topic: str | None = typer.Argument(None, help="Optional command name."),
) -> None:
    """Show commands and quick examples."""
    if topic:
        _render_topic(topic)
        return
    console.print("[bold]Docket commands[/bold]")
    console.print("Use `docket help <command>` for a focused example.\n")
    table = Table(show_header=True, header_style="bold cyan")
    table.add_column("Command", style="green", no_wrap=True)
    table.add_column("Description")
    for command in COMMANDS:
        table.add_row(command.name, command.summary)
    console.print(table)
    console.print(
        "\n[dim]Tip:[/dim] `docket` opens the TUI, and `docket --help` still shows Typer's built-in help."
    )


def _render_topic(topic: str) -> None:
    wanted = topic.strip().lower()
    for command in COMMANDS:
        if wanted == command.name:
            console.print(f"[bold]docket {command.name}[/bold]")
            console.print(command.summary)
            console.print(f"\n[dim]Example:[/dim] {command.usage}")
            return
    console.print(f"[red]Unknown command:[/red] {topic}")
    raise typer.Exit(2)
