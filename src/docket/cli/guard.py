"""Shared CLI guards — things every mutation command checks before running."""

from __future__ import annotations

import typer
from rich.console import Console

from docket.config.models import Config


def abort_if_read_only(console: Console, config: Config) -> None:
    """Refuse to run the mutation command when `runtime.read_only` is set in
    config.toml.

    Kept as a separate function (not a decorator) because the commands that
    need it are already typer-decorated and the extra indirection makes the
    signatures harder to read. Exit code 3 distinguishes this from user-cancel
    (1) and bad-argument (2)."""
    if config.runtime.read_only:
        console.print(
            "[yellow]Read-only mode[/yellow]: runtime.read_only is true in "
            "config.toml — mutation commands are disabled."
        )
        raise typer.Exit(3)


__all__ = ["abort_if_read_only"]
