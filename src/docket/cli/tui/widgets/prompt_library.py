from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Select, Static, TextArea

from docket.agent.prompt import (
    get_template,
    list_templates,
    read_prompt,
    reset_prompt,
    scaffold,
    write_prompt,
)
from docket.config.paths import Paths


class PromptLibraryModal(ModalScreen[None]):
    DEFAULT_CSS = """
    PromptLibraryModal { align: center middle; }
    PromptLibraryModal > Vertical {
        width: 94;
        max-width: 120;
        height: 86%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    PromptLibraryModal #title {
        height: auto;
        color: $accent;
        text-style: bold;
    }
    PromptLibraryModal #subtitle {
        height: auto;
        color: $text-muted;
        padding-bottom: 1;
    }
    PromptLibraryModal .field-label {
        height: auto;
        color: $text-muted;
        padding-top: 1;
    }
    PromptLibraryModal #editor {
        height: 1fr;
        border: round $panel-lighten-1;
        background: $panel;
    }
    PromptLibraryModal #hint {
        height: auto;
        color: $text-muted;
        padding-top: 1;
    }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+r", "reset_default", "Reset", priority=True),
        Binding("escape", "cancel", "Close", priority=True),
    ]

    def __init__(self, paths: Paths) -> None:
        super().__init__()
        self._paths = paths

    def compose(self) -> ComposeResult:
        options = [(template.label, template.key) for template in list_templates()]
        with Vertical():
            yield Static("Prompt library", id="title")
            yield Static(
                "Edit the assistant instructions without touching files by hand. Changes apply on the next turn.",
                id="subtitle",
            )
            yield Static("prompt", classes="field-label")
            picker = Select(
                options=options,
                value="system_base",
                prompt="choose a prompt",
                id="prompt-key",
            )
            picker.tooltip = "Pick which prompt file to edit."
            yield picker
            yield Static("content", classes="field-label")
            editor = TextArea("", id="editor")
            editor.tooltip = "Edit the selected prompt. Ctrl+S saves, Ctrl+R restores the default."
            yield editor
            yield Static(
                "Ctrl+S save  ·  Ctrl+R reset to default  ·  Esc close",
                id="hint",
            )

    def on_mount(self) -> None:
        scaffold(self._paths.prompts_dir)
        self._load_selected_prompt()
        self.query_one("#prompt-key", Select).focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id != "prompt-key":
            return
        self._load_selected_prompt()

    def action_save(self) -> None:
        key = self._selected_key()
        if key is None:
            self.app.notify("Choose a prompt first.", severity="warning")
            return
        text = self.query_one("#editor", TextArea).text
        target = write_prompt(self._paths.prompts_dir, key, text)
        self.app.notify(f"Saved {target.name}", severity="information")

    def action_reset_default(self) -> None:
        key = self._selected_key()
        if key is None:
            self.app.notify("Choose a prompt first.", severity="warning")
            return
        target = reset_prompt(self._paths.prompts_dir, key)
        self._load_selected_prompt()
        self.app.notify(f"Reset {target.name} to the default prompt.", severity="information")

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _selected_key(self) -> str | None:
        value = self.query_one("#prompt-key", Select).value
        if value is Select.BLANK or not isinstance(value, str):
            return None
        return value

    def _load_selected_prompt(self) -> None:
        key = self._selected_key()
        if key is None:
            return
        template = get_template(key)
        self.query_one("#editor", TextArea).text = read_prompt(self._paths.prompts_dir, key)
        self.query_one("#subtitle", Static).update(
            f"Editing {template.label} ({template.filename}). Changes apply on the next assistant turn."
        )
