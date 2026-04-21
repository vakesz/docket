"""Modal screen for switching the Textual theme.

Lists every theme Textual knows about (including user-registered themes)
and applies each one live as the user moves through the list. Enter saves
the choice to `config.ui.theme` and closes; Esc reverts to the theme that
was active when the picker opened and closes.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, ClassVar

from textual.app import ComposeResult
from textual.binding import BindingType
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import OptionList, Static
from textual.widgets.option_list import Option

if TYPE_CHECKING:
    from docket.config.models import Config
    from docket.config.paths import Paths


class ThemePicker(ModalScreen[None]):
    """Dismissed silently once the user commits or cancels — the mutation
    (if any) has already been applied to `app.theme` and, on commit, to
    the on-disk config."""

    DEFAULT_CSS = """
    ThemePicker {
        align: center middle;
    }
    ThemePicker > Vertical {
        width: 50;
        height: auto;
        max-height: 80%;
        padding: 1 2;
        border: round $accent;
        background: $panel;
    }
    ThemePicker #title {
        height: 1;
        padding-bottom: 1;
        color: $text-muted;
    }
    ThemePicker OptionList {
        height: auto;
        max-height: 20;
        border: none;
        background: $panel;
    }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        ("escape", "cancel", "Cancel"),
    ]

    def __init__(self, paths: Paths | None = None, config: Config | None = None) -> None:
        super().__init__()
        self._paths = paths
        self._config = config
        # Snapshot the theme on open so Esc can revert after live previews.
        self._original_theme: str = ""

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("Theme  ·  ↑↓ preview  ·  Enter save  ·  Esc cancel", id="title")
            names = sorted(self.app.available_themes.keys())
            current = self.app.theme
            options = [Option(name, id=name) for name in names]
            option_list = OptionList(*options, id="themes")
            yield option_list
            if current in names:
                option_list.highlighted = names.index(current)

    def on_mount(self) -> None:
        self._original_theme = self.app.theme
        self.query_one(OptionList).focus()

    def on_option_list_option_highlighted(self, event: OptionList.OptionHighlighted) -> None:
        """Live preview as the user arrows through the list."""
        if event.option.id:
            self.app.theme = event.option.id

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        """Enter — persist the current theme and close."""
        if event.option.id:
            self.app.theme = event.option.id
            self._persist(event.option.id)
        self.dismiss(None)

    def action_cancel(self) -> None:
        """Esc — revert to whatever was active when the picker opened."""
        if self._original_theme:
            self.app.theme = self._original_theme
        self.dismiss(None)

    def _persist(self, theme_name: str) -> None:
        """Write the theme into config.toml if we were given the handles.

        When launched from pilot tests without paths/config, persistence is
        simply a no-op — the live preview still works, the save just doesn't
        touch disk."""
        if self._paths is None or self._config is None:
            return
        try:
            from docket.config.loader import save_config

            self._config.ui.theme = theme_name
            save_config(self._paths, self._config)
        except Exception:
            # Writing config should never crash the TUI.
            self.app.notify("Saved theme preview only — could not write config.", severity="warning")
