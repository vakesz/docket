from __future__ import annotations

import typer

from docket.config.setup_wizard import run_wizard


def setup_command(
    step: str | None = typer.Option(None, "--step", help="Jump directly to a wizard step."),
) -> None:
    """Run (or re-run) the first-time setup wizard."""
    run_wizard(start_at=step)
