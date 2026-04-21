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

from docket.core.model import TransitionIntent

if TYPE_CHECKING:
    from docket.cli.tui.app import ItvApp

_INTENT_LABELS: dict[TransitionIntent, str] = {
    TransitionIntent.START_WORK: "Start work",
    TransitionIntent.PAUSE: "Pause",
    TransitionIntent.BLOCK: "Block",
    TransitionIntent.NEEDS_INFO: "Needs info",
    TransitionIntent.CLOSE_DONE: "Close (done)",
    TransitionIntent.CLOSE_WONTFIX: "Close (won't fix)",
    TransitionIntent.REOPEN: "Reopen",
}


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
        commands: list[tuple[str, str, Callable[[], None]]] = [
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
                "New work item",
                "Open the create-ticket form with duplicate check.",
                app.action_new_item,
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
        # One palette entry per TransitionIntent, scoped to the current item.
        # Hidden when nothing is selected — the action itself would just toast,
        # but the palette is cleaner if the option isn't there to tempt you.
        if getattr(app, "_selected_item_id", None) is not None:
            for intent, label in _INTENT_LABELS.items():
                commands.append(
                    (
                        f"Transition → {label}",
                        f"Stage a '{intent.value}' transition for the selected item.",
                        _make_transition_callback(app, intent),
                    )
                )
        return commands


def _make_transition_callback(app: ItvApp, intent: TransitionIntent) -> Callable[[], None]:
    """Bind the intent into a zero-arg closure so the palette's command slot
    (which only accepts `Callable[[], None]`) can still reach the right one."""
    return lambda: app.action_transition(intent.value)
