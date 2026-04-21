"""Command-palette provider for the Docket TUI.

Registers the app's actions with Textual's built-in `Ctrl+P` palette so the
user can discover and trigger them by name (with fuzzy search) without
memorizing keybinds. Each command delegates to an existing `action_*`
method on `ItvApp` — the palette is a discoverability layer, not a second
home for behavior.
"""
from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from textual.command import DiscoveryHit, Hit, Hits, Provider

if TYPE_CHECKING:
    from docket.cli.tui.app import ItvApp


class DocketCommands(Provider):
    """Exposes Docket's main actions in the command palette."""

    async def search(self, query: str) -> Hits:
        matcher = self.matcher(query)
        for label, help_text, callback in self._commands():
            score = matcher.match(label)
            if score > 0:
                yield Hit(
                    score=score,
                    match_display=matcher.highlight(label),
                    command=callback,
                    help=help_text,
                )

    async def discover(self) -> Hits:
        for label, help_text, callback in self._commands():
            yield DiscoveryHit(display=label, command=callback, help=help_text)

    def _commands(self) -> list[tuple[str, str, Callable[[], None]]]:
        app: ItvApp = self.app  # type: ignore[assignment]
        return [
            ("Sync now", "Pull the latest items from the active provider.", app.action_refresh),
            ("Pick theme", "Switch the TUI theme with live preview.", app.action_pick_theme),
            (
                "Fullscreen pane",
                "Toggle maximize on the focused pane.",
                app.action_toggle_fullscreen,
            ),
            (
                "Quick-open by id",
                "Jump to a specific ticket by id.",
                app.action_quick_open,
            ),
            (
                "New thread",
                "Archive the current chat thread and start fresh.",
                app.action_new_thread,
            ),
            (
                "Review pending proposals",
                "Show the next pending mutation diff.",
                app.action_review_pending,
            ),
            (
                "Suggest next action",
                "Ask the agent for a structured next step.",
                app.action_suggest_next,
            ),
            (
                "Open in browser",
                "Open the selected ticket in your browser.",
                app.action_open_in_browser,
            ),
        ]
