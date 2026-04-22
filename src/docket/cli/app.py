from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.commands.help import help_command
from docket.cli.commands.list import list_command
from docket.cli.commands.new import new_command
from docket.cli.commands.open import open_command, run_open_tui
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
        # Go through the primitive-only entry point. Calling `open_command()`
        # directly (or via `ctx.invoke`, which Click routes through the raw
        # Python function) would hand it the `typer.OptionInfo` sentinels as
        # defaults — truthy objects that silently flip `--read-only` on and
        # stringify as `--provider <typer.models.OptionInfo ...>`. Every flag
        # has to be explicit here; a new one missing from this call is a
        # TypeError, not a silent bug.
        run_open_tui(scope=None, no_chat=False, read_only=False, provider=None)


app.add_typer(setup_app, name="setup")
app.command("sync")(sync_command)
app.command("list")(list_command)
app.command("show")(show_command)
app.command("open")(open_command)
app.command("transition")(transition_command)
app.command("patch")(patch_command)
app.command("new")(new_command)
app.command("serve")(serve_command)
app.command("help")(help_command)


def main() -> None:
    app()
