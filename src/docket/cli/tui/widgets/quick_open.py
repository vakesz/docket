"""Quick-open-by-id modal.

Triggered by typing `:` in the main app. The user enters a ticket id, and
Enter posts `ItemSelected` back through the app so the rest of the detail
+ chat wiring stays on one code path.
"""

from __future__ import annotations

import sqlite3
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import BindingType
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Input, Static

from docket.storage.repos import item_repo


class QuickOpenResult:
    """Dismissal payload. `item_id` is None when the user cancels."""

    def __init__(self, item_id: str | None) -> None:
        self.item_id = item_id


class QuickOpenModal(ModalScreen[QuickOpenResult]):
    DEFAULT_CSS = """
    QuickOpenModal {
        align: center middle;
    }
    QuickOpenModal > Vertical {
        width: 60;
        height: auto;
        padding: 1 2;
        border: round $accent;
        background: $panel;
    }
    QuickOpenModal #hint {
        height: 1;
        color: $text-muted;
        padding-bottom: 1;
    }
    QuickOpenModal #status {
        height: 1;
        color: $text-muted;
        padding-top: 1;
    }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "cancel", "Cancel"),
    ]

    def __init__(self, conn: sqlite3.Connection) -> None:
        super().__init__()
        self._conn = conn
        self.tooltip = "Jump straight to a cached work item by id."

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Open ticket by id", id="hint")
            yield Input(placeholder="ticket id (e.g. 42 or AUTH-42)", id="qo-input")
            yield Static("", id="status")

    def on_mount(self) -> None:
        field = self.query_one("#qo-input", Input)
        field.tooltip = "Enter a cached item id like `S-42` or `AUTH-42`."
        field.focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Tell the user up-front whether the id is in cache, before they hit Enter."""
        raw = (event.value or "").strip()
        status = self.query_one("#status", Static)
        if not raw:
            status.update("")
            return
        item = item_repo.get_item(self._conn, raw)
        status.update("found" if item is not None else "not in cache — press Enter anyway to try")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        raw = (event.value or "").strip()
        if not raw:
            return
        self.dismiss(QuickOpenResult(item_id=raw))

    def action_cancel(self) -> None:
        self.dismiss(QuickOpenResult(item_id=None))
