"""Shared confirm-before-mutate flow for all CLI commands.

Shows the diff, asks for a keypress, returns True iff the user agreed. Same code
path covers interactive CLI, interactive TUI modals, and the HTTP two-step flow.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

import typer
from rich.panel import Panel
from rich.prompt import Prompt

from docket.cli._console import console
from docket.core.mutation import Proposal, render_diff
from docket.core.services import mutation_service
from docket.core.services.mutation_service import MutationResult
from docket.providers.base import WorkItemProvider


def prompt_confirm(proposal: Proposal, *, title: str = "Proposed change") -> bool:
    diff = render_diff(proposal)
    console.print(Panel(diff, title=title, border_style="yellow"))
    answer = Prompt.ask("Apply this change?", choices=["y", "n"], default="n")
    return answer == "y"


def apply_mutation(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    proposal: Proposal,
    *,
    confirm_title: str,
    dry_run: bool,
    on_success: Callable[[MutationResult], str],
    provider_key: str = "",
) -> None:
    """Run the propose → confirm → apply loop shared by every mutating CLI command.

    Prints a dry-run marker when `dry_run=True`, otherwise prompts for confirmation
    and either cancels (exit 1) or applies + prints `on_success(result)`."""
    if dry_run:
        result = mutation_service.confirm(conn, provider, proposal, dry_run=True)
        console.print(f"[dim]dry-run — would apply proposal {result.proposal_id}[/dim]")
        return
    if not prompt_confirm(proposal, title=confirm_title):
        console.print("[yellow]cancelled[/yellow]")
        raise typer.Exit(1)
    result = mutation_service.confirm(conn, provider, proposal, provider_key=provider_key)
    console.print(on_success(result))
