"""Three-pane layout primitives.

`Pane` is the resizable/maximizable container used for backlog/detail/chat;
`FullscreenToggle` is the clickable ⤢ affordance docked at the top of each
pane that mirrors the Ctrl+F keybinding.

Lifted out of `app.py` so the layout primitives live next to each other and
the app file stays focused on app-level wiring."""

from __future__ import annotations

from textual.containers import Vertical
from textual.widget import Widget
from textual.widgets import Static


class Pane(Vertical):
    """A resizable/maximizable container used for each of the three panes.

    `Vertical.allow_maximize` is a read-only property in this Textual version,
    so we subclass to flip the class-level flag rather than assign per-instance.
    Every pane shares a single muted border; the `:focus-within` pseudo-class
    swaps it for an accent border so the active pane is obvious when tabbing.
    """

    allow_maximize = True
    # Focusable so Escape from a child Input (e.g. the chat prompt) can land
    # here instead of the App root — single-key bindings then work again and
    # the pane's :focus-within border still lights up because the Pane itself
    # is the focus target.
    can_focus = True

    DEFAULT_CSS = """
    Pane {
        background: $panel;
        border: round $panel-lighten-1;
        padding: 0;
    }
    Pane:focus, Pane:focus-within {
        border: round $accent;
    }
    """


class FullscreenToggle(Static):
    """Clickable ⤢ affordance docked at the top of each Pane.

    Mirrors the Ctrl+F keybinding: click toggles maximize/minimize on the
    owning Pane. Glyph flips to ⤡ while that pane is maximized so the
    action is discoverable and its state is visible.
    """

    DEFAULT_CSS = """
    FullscreenToggle {
        height: auto;
        background: transparent;
        color: $text-muted;
        content-align-horizontal: right;
        padding: 1 1 0 0;
    }
    FullscreenToggle:hover {
        color: $text;
        text-style: bold;
    }
    """

    GLYPH_MAXIMIZE = "⤢"
    GLYPH_MINIMIZE = "⤡"

    def __init__(self) -> None:
        super().__init__(self.GLYPH_MAXIMIZE)

    def on_click(self) -> None:
        from docket.cli.tui.app import DocketApp

        pane: Widget | None = self.parent if isinstance(self.parent, Widget) else None
        while pane is not None and not isinstance(pane, Pane):
            pane = pane.parent if isinstance(pane.parent, Widget) else None
        if pane is None:
            return
        app = self.app
        screen = self.screen
        if screen.maximized is not None:
            screen.minimize()
            if isinstance(app, DocketApp):
                app.restore_pane_widths()
        else:
            if isinstance(app, DocketApp):
                app.clear_pane_width_override(pane)
            screen.maximize(pane)
        if isinstance(app, DocketApp):
            app.sync_fullscreen_icons()


__all__ = ["FullscreenToggle", "Pane"]
