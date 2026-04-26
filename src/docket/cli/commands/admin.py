"""Operator-facing utilities. Today: print the bearer token from config.toml
so a human can paste it into a frontend or the wizard. Kept under its own
sub-app so the surface stays discoverable (`docket admin --help`)."""

from __future__ import annotations

import typer

from docket._console import console
from docket.config import load_config, resolve_paths
from docket.config.loader import ConfigMissingError

admin_app = typer.Typer(
    name="admin",
    help="Operator utilities (bearer token, debug helpers).",
    no_args_is_help=True,
    add_completion=False,
)


@admin_app.command("print-token")
def print_token() -> None:
    """Print the current `[http].token` from config.toml.

    Useful when you've forgotten the bootstrap token and need to paste it
    into the frontend or the setup wizard. Exits with code 1 if no
    config.toml exists yet (run `docket serve` to mint one) or 2 if the
    config has no token."""
    paths = resolve_paths()
    try:
        config = load_config(paths)
    except ConfigMissingError:
        console.print(
            "[yellow]No config.toml found at[/yellow] "
            f"{paths.config_file} — run `docket serve` to mint a bootstrap token."
        )
        raise typer.Exit(code=1) from None

    token = config.http.token
    if not token:
        console.print("[red]No bearer token configured[/red]. Run `docket setup` to generate one.")
        raise typer.Exit(code=2)

    console.print(token)
