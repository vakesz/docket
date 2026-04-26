"""Settings, theme, prompt-library, and default-provider plumbing for `DocketApp`.

All of these actions share the same shape: open a modal (or toggle an
in-context preference), write changes back to `config.toml`, then update
the running UI so the preference takes effect without a restart where it
can. Free helpers, not a mixin: `DocketApp` keeps thin `action_*`
delegates so Textual's binding dispatcher can resolve them, but the
mechanics live here as `app: DocketApp` callables."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from textual.widgets import Input

from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.prompt_library import PromptLibraryModal
from docket.cli.tui.widgets.settings_modal import SettingsModal
from docket.cli.tui.widgets.theme_picker import ThemePicker
from docket.config import save_config
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.model import ItemKind

if TYPE_CHECKING:
    from docket.cli.tui.app import DocketApp


def pick_theme(app: DocketApp) -> None:
    """Open the theme picker modal."""
    app.push_screen(ThemePicker(paths=app.tui_ctx.paths, config=app.tui_ctx.config))


def apply_saved_theme(app: DocketApp) -> None:
    """If the caller provided a config, honor its saved theme at startup.

    Silently ignores an unknown theme name so a stale config doesn't
    crash the TUI — the user can just pick a new one."""
    config = app.tui_ctx.config
    if config is None:
        return
    saved = getattr(getattr(config, "ui", None), "theme", None)
    if not saved:
        return
    if saved in app.available_themes:
        app.theme = saved


def open_settings(app: DocketApp) -> None:
    paths, config = app.tui_ctx.paths, app.tui_ctx.config
    if paths is None or config is None:
        app.notify("Settings are unavailable in this session.", severity="warning")
        return
    app.run_worker(_open_settings_flow(app, paths, config), group="settings", exclusive=False)


async def _open_settings_flow(app: DocketApp, paths: Paths, config: Config) -> None:
    result = await app.push_screen_wait(SettingsModal(paths, config))
    if result is not None:
        apply_saved_config(app, result)


def edit_prompts(app: DocketApp) -> None:
    if app.tui_ctx.paths is None:
        app.notify("Prompt library is unavailable in this session.", severity="warning")
        return
    app.push_screen(PromptLibraryModal(app.tui_ctx.paths))


_BUCKET_CYCLE: tuple[Literal["open", "closed", "all"], ...] = ("open", "closed", "all")


def cycle_state_bucket(app: DocketApp) -> None:
    """Cycle the active view's `state_bucket` (open → closed → all → open).

    Session-only — the saved view in `config.toml` is unchanged. Re-runs
    the current filter input so the cycle respects whatever the user has
    typed into the search box."""
    from dataclasses import replace as dc_replace

    current = app.tui_ctx.scope.state_bucket
    try:
        idx = _BUCKET_CYCLE.index(current)
    except ValueError:
        idx = -1
    nxt = _BUCKET_CYCLE[(idx + 1) % len(_BUCKET_CYCLE)]
    app.tui_ctx.scope = dc_replace(app.tui_ctx.scope, state_bucket=nxt)
    try:
        filter_input = app.query_one("#filter", Input)
    except Exception:
        app._reload_tree()
    else:
        app._apply_filter(filter_input.value or "")
    app.notify(f"State bucket: {nxt}.", severity="information")


def set_default_provider(app: DocketApp) -> None:
    """Persist the current provider as `config.active_provider`.

    Writes the full config back to `config.toml` via `save_config` so the
    choice sticks across launches. Pilot tests that mount the TUI without
    `paths`/`config` get a warning toast instead of a crash."""
    config = app.tui_ctx.config
    paths = app.tui_ctx.paths
    key = app.tui_ctx.provider_key
    if config is None or paths is None:
        app.notify(
            "Can't persist default provider — config paths not wired.",
            severity="warning",
        )
        return
    if not key or key not in config.providers:
        app.notify("No active provider to pin as default.", severity="warning")
        return
    if config.active_provider == key:
        entry = config.providers[key]
        app.notify(
            f"'{entry.display_name}' is already the default provider.",
            severity="information",
        )
        return
    config.active_provider = key
    try:
        save_config(paths, config)
    except Exception as e:
        app.notify(humanize_error(e, action="Save config"), severity="error")
        return
    entry = config.providers[key]
    app.notify(
        f"Default provider set to '{entry.display_name}'. Opens here on next launch.",
        severity="information",
    )


def apply_saved_config(app: DocketApp, config: Config) -> None:
    """Update the in-memory settings after the modal persists config.toml.

    Display and form behavior can refresh in-session. Provider wiring and
    recurring timers are read at startup, so those changes take effect on
    the next app launch."""
    app.tui_ctx.config = config
    app.tui_ctx.compaction_threshold_tokens = config.llm.compaction_threshold_tokens
    app.tui_ctx.external_watch_interval_seconds = config.llm.external_watch_interval_seconds
    app.tui_ctx.background_sync_interval_seconds = config.sync.background_interval_seconds
    app.tui_ctx.background_sync_min_interval_by_provider = dict(
        config.sync.min_interval_seconds_by_provider
    )
    app.tui_ctx.stale_threshold_days = config.stale.threshold_days
    app.tui_ctx.stale_threshold_by_provider = dict(config.stale.threshold_days_by_provider)
    app.tui_ctx.default_new_item_kind = ItemKind(config.ui.default_new_item_kind)
    app.tui_ctx.show_acceptance_criteria = config.ui.show_acceptance_criteria
    app.query_one(ItemTree).stale_threshold_days = app._resolved_stale_threshold()
    app.query_one(ChatPane).set_show_acceptance_criteria(config.ui.show_acceptance_criteria)
    entry = config.providers.get(app.tui_ctx.provider_key) if app.tui_ctx.provider_key else None
    if entry is not None and entry.active_view in entry.views:
        app.action_switch_view(entry.active_view)
    else:
        app._reload_tree()
    app.notify(
        "Settings saved. View and prompt behavior updated now; provider and timer changes apply on the next launch.",
        severity="information",
    )


__all__ = [
    "apply_saved_config",
    "apply_saved_theme",
    "cycle_state_bucket",
    "edit_prompts",
    "open_settings",
    "pick_theme",
    "set_default_provider",
]
