from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Markdown, Static

_HELP_MARKDOWN = """\
## Core workflow

- Use the left pane to browse work items.
- Press `/` to filter by title, description, or comments.
- Press `Enter` on a row to load details and chat context.
- Use `Tab` and `Shift+Tab` to move between backlog, details, and assistant.

## Shortcuts

- `Ctrl+P` command palette
- `:` quick-open by item id
- `,` settings editor
- `p` prompt library
- `Ctrl+T` theme picker
- `Ctrl+F` maximize the focused pane
- `Ctrl+Left` / `Ctrl+Right` resize the focused pane
- `r` sync now
- `n` new work item
- `d` review pending proposals
- `s` suggest next action
- `o` open the selected item in your browser
- `t` start a new chat thread for the selected item
- `q` quit

## Tips

- Settings save to `config.toml` so non-technical users can update behavior without editing files.
- Prompt edits apply on the next assistant turn.
- Provider connection changes are saved immediately, but a restart gives the cleanest re-connect.
"""


class HelpModal(ModalScreen[None]):
    DEFAULT_CSS = """
    HelpModal { align: center middle; }
    HelpModal > Vertical {
        width: 92;
        max-width: 110;
        height: 80%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    HelpModal #title {
        height: auto;
        color: $accent;
        text-style: bold;
        padding-bottom: 1;
    }
    HelpModal #subtitle {
        height: auto;
        color: $text-muted;
        padding-bottom: 1;
    }
    HelpModal VerticalScroll {
        height: 1fr;
        border: round $panel-lighten-1;
        padding: 0 1;
        background: $panel;
    }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "close", "Close"),
        ("question_mark", "close", "Close"),
        ("h", "close", "Close"),
    ]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Docket help", id="title")
            yield Static(
                "Shortcuts, navigation, and the quickest path through the app.",
                id="subtitle",
            )
            with VerticalScroll():
                yield Markdown(_HELP_MARKDOWN)

    def action_close(self) -> None:
        self.dismiss(None)
