"""Shared confirm-before-mutate flow for all CLI commands.

Shows the diff, asks for a keypress, returns True iff the user agreed. Same code
path covers interactive CLI, interactive TUI modals, and (later) HTTP two-step flow.
"""

from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Prompt

from docket.core.mutation import Proposal, render_diff

console = Console()


def prompt_confirm(proposal: Proposal, *, title: str = "Proposed change") -> bool:
    diff = render_diff(proposal)
    console.print(Panel(diff, title=title, border_style="yellow"))
    answer = Prompt.ask("Apply this change?", choices=["y", "n"], default="n")
    return answer == "y"
