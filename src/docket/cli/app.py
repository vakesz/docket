from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.commands.list_cmd import list_command
from docket.cli.commands.new import new_command
from docket.cli.commands.open import open_command
from docket.cli.commands.patch import patch_command
from docket.cli.commands.setup import setup_command
from docket.cli.commands.show import show_command
from docket.cli.commands.sync import sync_command
from docket.cli.commands.transition import transition_command

console = Console()

app = typer.Typer(
    name="docket",
    help="Terminal work-item triage with LLM chat and safe mutations.",
    no_args_is_help=True,
    add_completion=False,
)

app.command("setup")(setup_command)
app.command("sync")(sync_command)
app.command("list")(list_command)
app.command("show")(show_command)
app.command("open")(open_command)
app.command("transition")(transition_command)
app.command("patch")(patch_command)
app.command("new")(new_command)


def main() -> None:
    app()
