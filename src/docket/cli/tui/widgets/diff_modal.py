from __future__ import annotations

from dataclasses import replace
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Static, TextArea

from docket.core.mutation import DescriptionPatch, Proposal, render_diff


class DiffModal(ModalScreen[Proposal | None]):
    """Shows a mutation proposal and asks for y/n confirmation, with an
    optional inline edit for description patches.

    Dismisses with the proposal on confirm (possibly edited in-place), `None`
    on reject/escape. Callers should treat `None` as reject and use whatever
    proposal comes back as the source of truth for the confirm call — the
    user may have mutated it via the edit path.

    `e` mounts a TextArea pre-filled with the proposed description; Ctrl+S
    rebuilds the proposal with the edited text and re-renders the diff so
    the user can review before confirming. `e` is only meaningful for
    DescriptionPatch today — other proposal kinds show a notification and
    stay on the diff view."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("y", "confirm", "Confirm", priority=True),
        Binding("n", "reject", "Reject", priority=True),
        Binding("e", "edit", "Edit", priority=True),
        Binding("ctrl+s", "save_edit", "Save edit", priority=True, show=False),
        Binding("escape", "cancel", "Cancel", priority=True),
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
    DiffModal #editor { height: 15; border: round $panel-lighten-2; }
    DiffModal #hint { color: $text-muted; }
    """

    def __init__(self, proposal: Proposal, *, source: str = "agent") -> None:
        super().__init__()
        self._proposal = proposal
        self._source = source
        self._editor: TextArea | None = None

    @property
    def _editing(self) -> bool:
        return self._editor is not None

    def compose(self) -> ComposeResult:
        with Vertical(id="body"):
            yield Static(f"[b]Pending change[/b] · from {self._source}", id="source")
            yield Static(render_diff(self._proposal), id="diff")
            yield Static(self._hint_text(), id="hint")

    def _hint_text(self) -> str:
        if self._editing:
            return "[b]ctrl+s[/b] save  ·  [b]esc[/b] cancel edit"
        return "[b]y[/b] confirm  ·  [b]n[/b] reject  ·  [b]e[/b] edit  ·  [b]esc[/b] cancel"

    def action_confirm(self) -> None:
        if self._editing:
            return
        self.dismiss(self._proposal)

    def action_reject(self) -> None:
        if self._editing:
            return
        self.dismiss(None)

    def action_cancel(self) -> None:
        """Esc: if editing, leave edit mode without saving; otherwise reject."""
        if self._editing:
            self._leave_edit_mode()
            return
        self.dismiss(None)

    def action_edit(self) -> None:
        if self._editing:
            return
        if not isinstance(self._proposal, DescriptionPatch):
            self.app.notify(
                "Edit is only available for description patches.",
                severity="warning",
            )
            return
        body = self.query_one("#body", Vertical)
        diff = self.query_one("#diff", Static)
        diff.display = False
        editor = TextArea(self._proposal.new_md, id="editor")
        body.mount(editor, after=diff)
        self._editor = editor
        self.query_one("#hint", Static).update(self._hint_text())
        editor.focus()

    def action_save_edit(self) -> None:
        if self._editor is None or not isinstance(self._proposal, DescriptionPatch):
            return
        new_text = self._editor.text
        self._proposal = replace(self._proposal, new_md=new_text)
        self.query_one("#diff", Static).update(render_diff(self._proposal))
        self._leave_edit_mode()

    def _leave_edit_mode(self) -> None:
        if self._editor is not None:
            self._editor.remove()
            self._editor = None
        self.query_one("#diff", Static).display = True
        self.query_one("#hint", Static).update(self._hint_text())

    @property
    def proposal(self) -> Proposal:
        """Expose the (possibly edited) proposal so callers can confirm the
        edited version rather than the original."""
        return self._proposal
