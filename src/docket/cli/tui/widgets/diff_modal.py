from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Static

from docket.core.mutation import Proposal, render_diff


class DiffModal(ModalScreen[bool]):
    """Shows a mutation proposal and asks for y/n confirmation.

    Dismisses with `True` on confirm, `False` on reject, `None` if the user
    hits escape without deciding (treated as reject by callers)."""

    BINDINGS = [
        Binding("y", "confirm", "Confirm", priority=True),
        Binding("n", "reject", "Reject", priority=True),
        Binding("escape", "reject", "Reject", priority=True),
    ]

    DEFAULT_CSS = """
    DiffModal { align: center middle; }
    DiffModal > Vertical {
        width: 80%;
        max-width: 120;
        height: auto;
        max-height: 80%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    DiffModal #source { color: $text-muted; padding-bottom: 1; }
    DiffModal #diff { padding-bottom: 1; }
    DiffModal #hint { color: $text-muted; }
    """

    def __init__(self, proposal: Proposal, *, source: str = "agent") -> None:
        super().__init__()
        self._proposal = proposal
        self._source = source

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(f"[b]Pending change[/b] · from {self._source}", id="source")
            yield Static(render_diff(self._proposal), id="diff")
            yield Static("[b]y[/b] confirm  ·  [b]n[/b] reject  ·  [b]esc[/b] cancel", id="hint")

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_reject(self) -> None:
        self.dismiss(False)
