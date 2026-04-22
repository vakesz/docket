"""Shared CLI guards — things every mutation command checks before running."""

from __future__ import annotations

import typer
from rich.console import Console

from docket.config.env import get_read_only


def abort_if_read_only(console: Console) -> None:
    """Refuse to run the mutation command if `DOCKET_READ_ONLY` is set.

    Kept as a separate function (not a decorator) because the commands that
    need it are already typer-decorated and the extra indirection makes the
    signatures harder to read. Exit code 3 distinguishes this from user-cancel
    (1) and bad-argument (2)."""
    if get_read_only():
        console.print(
            "[yellow]Read-only mode[/yellow]: DOCKET_READ_ONLY is set — "
            "mutation commands are disabled."
        )
        raise typer.Exit(3)


__all__ = ["abort_if_read_only"]
