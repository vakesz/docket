"""Setup command and its `provider` subcommands.

Layout:

    docket setup                       → runs the first-time wizard
    docket setup --step=<name>         → jumps to a specific step
    docket setup provider list         → show configured providers
    docket setup provider add <name>   → register a new provider
    docket setup provider remove <n>   → drop one

The subcommands don't trigger the wizard — they edit config.toml in place so
adding a second provider (e.g. github_stub) doesn't re-run az login or full
sync."""

from __future__ import annotations

import typer

from docket.config import provider_crud, setup_wizard

setup_app = typer.Typer(
    name="setup",
    help="Run the setup wizard or manage configured providers.",
    invoke_without_command=True,
    no_args_is_help=False,
    add_completion=False,
)
provider_app = typer.Typer(help="Manage configured providers.")
setup_app.add_typer(provider_app, name="provider")


@setup_app.callback()
def _setup_root(
    ctx: typer.Context,
    step: str | None = typer.Option(None, "--step", help="Jump directly to a wizard step."),
) -> None:
    """Without a subcommand, run (or re-run) the first-time setup wizard."""
    if ctx.invoked_subcommand is None:
        setup_wizard.run_wizard(start_at=step)


@provider_app.command("list")
def _provider_list() -> None:
    """Show the configured providers and their scopes."""
    provider_crud.provider_list()


@provider_app.command("add")
def _provider_add(
    name: str = typer.Argument(..., help="Short id for the new provider entry."),
    type_id: str = typer.Option(
        "github",
        "--type",
        "-t",
        help="Provider type (e.g. github, azure_devops, github_stub, or any registered via entry point).",
    ),
    display_name: str | None = typer.Option(
        None,
        "--display-name",
        help="Label for the TUI switcher. Defaults to the entry id.",
    ),
    make_active: bool = typer.Option(
        False,
        "--active",
        help="Make this the active provider on success.",
    ),
) -> None:
    """Register a new provider entry in config.toml."""
    provider_crud.provider_add(
        name,
        type_id,
        display_name=display_name,
        make_active=make_active,
    )


@provider_app.command("remove")
def _provider_remove(
    name: str = typer.Argument(..., help="Provider id to remove."),
) -> None:
    """Remove a provider entry from config.toml."""
    provider_crud.provider_remove(name)
