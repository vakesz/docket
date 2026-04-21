from __future__ import annotations

from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Static

from docket.core.services.suggestion_service import Suggestion


class SuggestionModal(ModalScreen[bool]):
    """Preview of a structured triage recommendation.

    Dismisses with `True` if the user accepts (caller stages proposals),
    `False` on reject, `None` on escape (treated as reject)."""

    BINDINGS = [
        Binding("y", "confirm", "Accept", priority=True),
        Binding("n", "reject", "Reject", priority=True),
        Binding("escape", "reject", "Reject", priority=True),
    ]

    DEFAULT_CSS = """
    SuggestionModal { align: center middle; }
    SuggestionModal > Vertical {
        width: 80%;
        max-width: 120;
        height: auto;
        max-height: 80%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    SuggestionModal #header { color: $text-muted; padding-bottom: 1; }
    SuggestionModal #intent { padding-bottom: 1; }
    SuggestionModal #description { padding-bottom: 1; }
    SuggestionModal #questions { padding-bottom: 1; color: $warning; }
    SuggestionModal #hint { color: $text-muted; }
    SuggestionModal VerticalScroll { height: auto; max-height: 30; }
    """

    def __init__(self, suggestion: Suggestion) -> None:
        super().__init__()
        self._suggestion = suggestion

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(
                f"[b]Suggested next action[/b] · {self._suggestion.item_id}",
                id="header",
            )
            yield Static(
                f"[b]intent[/b]  {self._suggestion.intent.value}",
                id="intent",
            )
            patch = self._suggestion.description_patch_md.strip()
            with VerticalScroll():
                if patch:
                    yield Static(
                        f"[b]description patch[/b]\n{patch}",
                        id="description",
                    )
                else:
                    yield Static(
                        "[b]description patch[/b]  (none — current description is fine)",
                        id="description",
                    )
                if self._suggestion.open_questions:
                    bullets = "\n".join(f"• {q}" for q in self._suggestion.open_questions)
                    yield Static(
                        f"[b]open questions[/b]\n{bullets}",
                        id="questions",
                    )
            yield Static(
                "[b]y[/b] accept & stage  ·  [b]n[/b] reject  ·  [b]esc[/b] cancel",
                id="hint",
            )

    def action_confirm(self) -> None:
        self.dismiss(True)

    def action_reject(self) -> None:
        self.dismiss(False)
