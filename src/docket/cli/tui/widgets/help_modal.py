from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Markdown, Static

_HELP_MARKDOWN = """\
## Navigation

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Cycle focus: backlog → details → assistant |
| `↑` / `↓` | Move through backlog rows |
| `↑` at top of list | Jump to search filter |
| `↓` in search filter | Jump to first item |
| `Escape` | Defocus chat input; close modals |

## Backlog

| Key | Action |
|---|---|
| `/` | Focus search filter (live full-text search) |
| `Enter` | Open selected item in details + assistant |
| `c` | Toggle visibility of resolved / closed items |
| `w` | Pin or unpin the selected item |
| `:` | Quick-open by ticket id |

## Item actions

| Key | Action |
|---|---|
| `n` | New work item (with duplicate check) |
| `o` | Open selected item in browser |
| `s` | Ask the assistant for a suggested next step |
| `d` | Review pending proposals (diff modal) |
| `t` | Start a new chat thread for the selected item |

## Proposals & diffs

| Key | Action |
|---|---|
| `y` | Confirm and apply the proposal |
| `n` | Reject the proposal |
| `e` | Edit the proposal before applying |
| `Ctrl+S` | Save edits in the edit view |
| `Escape` | Cancel / close |

## Configuration & tools

| Key | Action |
|---|---|
| `,` | Settings editor |
| `p` | Prompt library |
| `m` | Project memory |
| `u` | Project sources |
| `Shift+M` | MCP server config |
| `Ctrl+T` | Theme picker (live preview) |

## Layout

| Key | Action |
|---|---|
| `Ctrl+F` | Maximize / restore the focused pane |
| `Ctrl+Left` / `Ctrl+Right` | Shrink / grow the focused pane |
| `⤢` button | Click to maximize; `⤡` to restore |

## App

| Key | Action |
|---|---|
| `r` | Sync now |
| `Ctrl+P` | Command palette — search all actions |
| `?` / `F1` / `h` | This help screen |
| `q` | Quit |

---

*Tip: open `Ctrl+P` to search and run any action without memorizing keybinds.*
"""


class HelpModal(ModalScreen[None]):
    DEFAULT_CSS = """
    HelpModal { align: center middle; }
    HelpModal > Vertical {
        width: 96;
        max-width: 120;
        height: 85%;
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
            yield Static("Keyboard shortcuts", id="title")
            yield Static(
                "Ctrl+P searches all commands  ·  Escape or ? to close",
                id="subtitle",
            )
            with VerticalScroll():
                yield Markdown(_HELP_MARKDOWN)

    def action_close(self) -> None:
        self.dismiss(None)
