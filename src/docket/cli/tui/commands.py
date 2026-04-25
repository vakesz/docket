"""Command-palette provider for the Docket TUI.

Registers the app's actions with Textual's built-in `Ctrl+P` palette so the
user can discover and trigger them by name (with fuzzy search) without
memorizing keybinds. Each command delegates to an existing `action_*`
method on `DocketApp` — the palette is a discoverability layer, not a second
home for behavior.

Every palette entry carries a stable `id` so we can track usage in SQLite
(`command_usage_repo`) and float recently-run commands to the top of the
discovery list. Labels are allowed to change; ids aren't.
"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING

from textual.command import DiscoveryHit, Hit, Hits, Provider

from docket.core.model import TransitionIntent
from docket.storage.repos import command_usage_repo

if TYPE_CHECKING:
    from docket.cli.tui.app import DocketApp

_INTENT_LABELS: dict[TransitionIntent, str] = {
    TransitionIntent.START_WORK: "Start work",
    TransitionIntent.PAUSE: "Pause",
    TransitionIntent.BLOCK: "Block",
    TransitionIntent.NEEDS_INFO: "Needs info",
    TransitionIntent.CLOSE_DONE: "Close (done)",
    TransitionIntent.CLOSE_WONTFIX: "Close (won't fix)",
    TransitionIntent.REOPEN: "Reopen",
}

#: How many recently-run commands to float to the top of the discover() list.
#: Small on purpose — the point is muscle-memory acceleration, not dominating
#: the palette with history.
_RECENT_LIMIT = 5


@dataclass(frozen=True)
class Command:
    """One palette entry.

    `id` is the stable usage-tracking key — never changes, never shown.
    `label` is what the user sees and searches against.
    `description` is the one-line help rendered next to the label.
    `example` is an optional tiny hint — typically a keybind or canonical
    argument — appended to `description` for extra context.
    """

    id: str
    label: str
    description: str
    callback: Callable[[], None]
    example: str = ""

    @property
    def help_text(self) -> str:
        if not self.example:
            return self.description
        return f"{self.description}  ·  {self.example}"


class DocketCommands(Provider):
    """Exposes Docket's main actions in the command palette."""

    @property
    def _docket_app(self) -> DocketApp:
        return self.app  # type: ignore[return-value]

    async def search(self, query: str) -> Hits:
        matcher = self.matcher(query)
        for command in self._commands():
            score = matcher.match(command.label)
            if score > 0:
                yield Hit(
                    score=score,
                    match_display=matcher.highlight(command.label),
                    command=self._wrap(command),
                    help=command.help_text,
                )

    async def discover(self) -> Hits:
        """Pre-search palette order: recents first, then the rest.

        `discover()` is what Textual shows when the palette opens with no
        query typed. Surfacing the last-used commands here is the whole
        point of recency tracking — a user who just pinned an item and
        wants to do it again sees "Pin current item" at the top."""
        commands = self._commands()
        ordered = self._order_with_recents(commands)
        for command, is_recent in ordered:
            prefix = "★ " if is_recent else ""
            yield DiscoveryHit(
                display=f"{prefix}{command.label}",
                command=self._wrap(command),
                help=command.help_text,
            )

    def _order_with_recents(self, commands: list[Command]) -> list[tuple[Command, bool]]:
        recents = self._recent_ids()
        if not recents:
            return [(c, False) for c in commands]
        by_id = {c.id: c for c in commands}
        # Recents preserve last-used order (newest first), skipping any id that
        # isn't currently available (e.g. a transition whose item isn't selected).
        recent_cmds: list[Command] = []
        seen: set[str] = set()
        for cid in recents:
            cmd = by_id.get(cid)
            if cmd is not None and cid not in seen:
                recent_cmds.append(cmd)
                seen.add(cid)
        rest = [c for c in commands if c.id not in seen]
        return [(c, True) for c in recent_cmds] + [(c, False) for c in rest]

    def _recent_ids(self) -> list[str]:
        app = self._docket_app
        conn = getattr(app.tui_ctx, "conn", None)
        if conn is None:
            return []
        try:
            return command_usage_repo.recent_ids(conn, limit=_RECENT_LIMIT)
        except Exception:
            # Palette must stay usable even if the DB misbehaves — swallow
            # errors and fall back to alphabetical order.
            return []

    def _wrap(self, command: Command) -> Callable[[], None]:
        """Return a callback that records usage, then fires the real action."""
        app = self._docket_app

        def _fire() -> None:
            conn = getattr(app.tui_ctx, "conn", None)
            if conn is not None:
                # Recording is best-effort; never block the action.
                with suppress(Exception):
                    command_usage_repo.record(conn, command.id)
            command.callback()

        return _fire

    def _commands(self) -> list[Command]:
        app = self._docket_app
        commands: list[Command] = [
            Command(
                id="show-help",
                label="Show help",
                description="Open the shortcut and workflow guide.",
                example="F1",
                callback=app.action_show_help,
            ),
            Command(
                id="open-settings",
                label="Open settings",
                description="Edit config.toml from inside the app.",
                callback=app.action_open_settings,
            ),
            Command(
                id="edit-prompts",
                label="Edit prompt library",
                description="Update the assistant's prompt templates without editing files manually.",
                callback=app.action_edit_prompts,
            ),
            Command(
                id="sync-now",
                label="Sync now",
                description="Pull the latest items from the active provider.",
                example="r",
                callback=app.action_refresh,
            ),
            Command(
                id="full-sync",
                label="Full sync",
                description="Reset the watermark and re-pull everything the active provider exposes.",
                example="R",
                callback=app.action_full_refresh,
            ),
            Command(
                id="pick-theme",
                label="Pick theme",
                description="Switch the TUI theme with live preview.",
                callback=app.action_pick_theme,
            ),
            Command(
                id="toggle-fullscreen",
                label="Fullscreen pane",
                description="Toggle maximize on the focused pane.",
                example="Ctrl+Shift+F",
                callback=app.action_toggle_fullscreen,
            ),
            Command(
                id="quick-open",
                label="Quick-open by id",
                description="Jump to a specific ticket by id.",
                example="g",
                callback=app.action_quick_open,
            ),
            Command(
                id="new-thread",
                label="New thread",
                description="Archive the current chat thread and start fresh.",
                callback=app.action_new_thread,
            ),
            Command(
                id="new-item",
                label="New work item",
                description="Open the create-ticket form with duplicate check.",
                example="n",
                callback=app.action_new_item,
            ),
            Command(
                id="review-pending",
                label="Review pending proposals",
                description="Show the next pending mutation diff.",
                callback=app.action_review_pending,
            ),
            Command(
                id="suggest-next",
                label="Suggest next action",
                description="Ask the agent for a structured next step.",
                callback=app.action_suggest_next,
            ),
            Command(
                id="open-in-browser",
                label="Open in browser",
                description="Open the selected ticket in your browser.",
                example="o",
                callback=app.action_open_in_browser,
            ),
            Command(
                id="toggle-done-visibility",
                label="Toggle done visibility",
                description="Show or hide resolved and closed items in the backlog.",
                example="c",
                callback=app.action_toggle_done_visibility,
            ),
            Command(
                id="open-memory",
                label="Open memory",
                description="View and edit the assistant's per-project memory.",
                example="m",
                callback=app.action_open_memory,
            ),
            Command(
                id="open-sources",
                label="Open sources",
                description="Manage project source documents the assistant can read.",
                example="u",
                callback=app.action_open_source,
            ),
            Command(
                id="open-mcp",
                label="Open MCP servers",
                description="Configure Model Context Protocol servers for this project.",
                example="Shift+M",
                callback=app.action_open_mcp,
            ),
        ]
        # Item-scoped actions — only appear when an item is selected.
        if getattr(app, "_selected_item_id", None) is not None:
            commands.append(
                Command(
                    id="toggle-pin",
                    label="Pin / unpin item",
                    description="Pin the selected item so it survives scope and view switches.",
                    example="w",
                    callback=app.action_toggle_pin,
                )
            )

        # One palette entry per TransitionIntent, scoped to the current item.
        # Hidden when nothing is selected — the action itself would just toast,
        # but the palette is cleaner if the option isn't there to tempt you.
        if getattr(app, "_selected_item_id", None) is not None:
            for intent, label in _INTENT_LABELS.items():
                commands.append(
                    Command(
                        id=f"transition-{intent.value}",
                        label=f"Transition → {label}",
                        description=f"Stage a '{intent.value}' transition for the selected item.",
                        callback=partial(app.action_transition, intent.value),
                    )
                )

        # Saved views: one "Switch view → <name>" per scope on the active
        # provider, minus the currently active one. Only surfaces when there's
        # somewhere to go.
        config = getattr(app.tui_ctx, "config", None)
        if config is not None:
            active_key = app.tui_ctx.provider_key
            entry = config.providers.get(active_key) if active_key else None
            if entry is not None:
                active_scope = app.tui_ctx.scope_key
                for name in sorted(entry.scopes):
                    if name == active_scope:
                        continue
                    commands.append(
                        Command(
                            id=f"switch-view-{active_key}-{name}",
                            label=f"Switch view → {name}",
                            description=f"Load the '{name}' saved view.",
                            callback=partial(app.action_switch_view, name),
                        )
                    )
            # Providers: one "Switch provider → <display>" per configured
            # provider except the active one. Hidden if only one configured.
            providers = app.tui_ctx.providers or {}
            for key in sorted(config.providers):
                if key == active_key:
                    continue
                if key not in providers:
                    continue  # plugin failed to load; skip it
                display = config.providers[key].display_name
                commands.append(
                    Command(
                        id=f"switch-provider-{key}",
                        label=f"Switch provider → {display}",
                        description=f"Activate the '{key}' provider for this session.",
                        callback=partial(app.action_switch_provider, key),
                    )
                )
            # Pin current provider as default — writes `active_provider` to
            # config.toml so the next launch opens here. Hidden when already
            # the default or when pilot-mounts haven't wired paths/config.
            active_entry = (
                config.providers.get(active_key) if active_key in config.providers else None
            )
            if (
                active_entry is not None
                and config.active_provider != active_key
                and app.tui_ctx.paths is not None
            ):
                commands.append(
                    Command(
                        id="set-default-provider",
                        label=f"Set default provider → {active_entry.display_name}",
                        description="Persist this provider as the default in config.toml.",
                        callback=app.action_set_default_provider,
                    )
                )
        return commands
