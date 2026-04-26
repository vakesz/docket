from __future__ import annotations

import os
from pathlib import Path

import typer

from docket.cli.commands.admin import admin_app
from docket.cli.commands.list import list_command
from docket.cli.commands.mcp import mcp_app
from docket.cli.commands.memory import memory_app
from docket.cli.commands.new import new_command
from docket.cli.commands.open import open_command, run_open_tui
from docket.cli.commands.patch import patch_command
from docket.cli.commands.project import project_app
from docket.cli.commands.serve import serve_command
from docket.cli.commands.setup import setup_app
from docket.cli.commands.show import show_command
from docket.cli.commands.source import source_app
from docket.cli.commands.status import status_command
from docket.cli.commands.sync import sync_command
from docket.cli.commands.transition import transition_command
from docket.config.paths import snapshot_pre_workspace_xdg

app = typer.Typer(
    name="docket",
    help="Terminal work-item triage with an interactive TUI, guided chat, and safe mutations.",
    # Run the TUI when `docket` is invoked with no subcommand; subcommands still work.
    invoke_without_command=True,
    no_args_is_help=False,
    add_completion=False,
)


def _apply_workspace(workspace: Path) -> None:
    """Redirect docket's XDG paths under `workspace`. Snapshots the user's
    real shell XDG vars first so external tools (`gh`, `az`) keep resolving
    against the user's home, not the dev sandbox."""
    snapshot_pre_workspace_xdg()
    root = workspace.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.environ["XDG_CONFIG_HOME"] = str(root / "config")
    os.environ["XDG_STATE_HOME"] = str(root / "state")
    os.environ["XDG_CACHE_HOME"] = str(root / "cache")
    os.environ["XDG_DATA_HOME"] = str(root / "data")


@app.callback()
def _root(
    ctx: typer.Context,
    workspace: Path | None = typer.Option(
        None,
        "--workspace",
        help="Redirect docket's XDG config/state/cache to this directory (dev sandbox).",
        envvar=None,
    ),
) -> None:
    if workspace is not None:
        _apply_workspace(workspace)
    if ctx.invoked_subcommand is None:
        # Go through the primitive-only entry point. Calling `open_command()`
        # directly (or via `ctx.invoke`, which Click routes through the raw
        # Python function) would hand it the `typer.OptionInfo` sentinels as
        # defaults — truthy objects that silently flip `--read-only` on and
        # stringify as `--provider <typer.models.OptionInfo ...>`. Every flag
        # has to be explicit here; a new one missing from this call is a
        # TypeError, not a silent bug.
        run_open_tui(view=None, no_chat=False, read_only=False, provider=None)


app.add_typer(setup_app, name="setup")
app.add_typer(admin_app, name="admin")
app.add_typer(project_app, name="project")
app.add_typer(memory_app, name="memory")
app.add_typer(source_app, name="source")
app.add_typer(mcp_app, name="mcp")
app.command("sync")(sync_command)
app.command("list")(list_command)
app.command("show")(show_command)
app.command("open")(open_command)
app.command("transition")(transition_command)
app.command("patch")(patch_command)
app.command("new")(new_command)
app.command("serve")(serve_command)
app.command("status")(status_command)


def main() -> None:
    app()
