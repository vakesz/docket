from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.commands.help_cmd import help_command
from docket.cli.commands.list_cmd import list_command
from docket.cli.commands.new import new_command
from docket.cli.commands.open import open_command
from docket.cli.commands.patch import patch_command
from docket.cli.commands.serve import serve_command
from docket.cli.commands.setup import setup_app
from docket.cli.commands.show import show_command
from docket.cli.commands.sync import sync_command
from docket.cli.commands.transition import transition_command

console = Console()

app = typer.Typer(
    name="docket",
    help="Terminal work-item triage with an interactive TUI, guided chat, and safe mutations.",
    # Run the TUI when `docket` is invoked with no subcommand; subcommands still work.
    invoke_without_command=True,
    no_args_is_help=False,
    add_completion=False,
)


@app.callback()
def _root(ctx: typer.Context) -> None:
    if ctx.invoked_subcommand is None:
        # Calling open_command() directly would pass typer OptionInfo sentinels
        # as the defaults — which are truthy objects, so `--read-only` would
        # silently flip on for every bare `docket` invocation. Fill in every
        # option explicitly so the command body sees real values.
        open_command(scope=None, no_chat=False, read_only=False)


app.add_typer(setup_app, name="setup")
app.command("sync")(sync_command)
app.command("refresh", hidden=True)(sync_command)
app.command("list")(list_command)
app.command("ls", hidden=True)(list_command)
app.command("show")(show_command)
app.command("view", hidden=True)(show_command)
app.command("open")(open_command)
app.command("browse", hidden=True)(open_command)
app.command("ui", hidden=True)(open_command)
app.command("transition")(transition_command)
app.command("patch")(patch_command)
app.command("new")(new_command)
app.command("create", hidden=True)(new_command)
app.command("serve")(serve_command)
app.command("help")(help_command)


def main() -> None:
    app()
