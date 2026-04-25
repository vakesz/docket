"""Settings, theme, prompt-library, and default-provider plumbing for `DocketApp`.

All of these actions share the same shape: open a modal (or toggle an
in-context preference), write changes back to `config.toml`, then update
the running UI so the preference takes effect without a restart where it
can. Keeping them together lets `DocketApp` stay focused on composition
and cross-cutting state."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING

from textual.widgets import Input

from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.prompt_library import PromptLibraryModal
from docket.cli.tui.widgets.settings_modal import SettingsModal
from docket.cli.tui.widgets.theme_picker import ThemePicker
from docket.config import save_config
from docket.config.models import Config
from docket.core.model import ItemKind

if TYPE_CHECKING:
    from textual.app import App

    _AppBase = App[None]
else:
    _AppBase = object


class ConfigMixin(_AppBase):
    """Settings modal, theme picker, prompt library, hide-done toggle, and
    default-provider persistence.

    Shape mirrors the other mixins: type-check as `App[None]` for Textual
    machinery, declare host-provided helpers under `TYPE_CHECKING` so mypy
    sees them without shadowing the real impls on MRO."""

    # Host-provided state.
    tui_ctx: TuiContext

    if TYPE_CHECKING:
        # Host-provided helpers (live in DocketApp).
        def _resolved_stale_threshold(self) -> int | None: ...
        # Sibling mixin (ItemSelectionMixin).
        def _reload_tree(self) -> None: ...
        def _apply_filter(self, raw: str) -> None: ...
        # Host-provided action (lives in DocketApp).
        def action_switch_view(self, name: str) -> None: ...

    # ---- theme ------------------------------------------------------------

    def action_pick_theme(self) -> None:
        """Open the theme picker modal."""
        self.push_screen(ThemePicker(paths=self.tui_ctx.paths, config=self.tui_ctx.config))

    def _apply_saved_theme(self) -> None:
        """If the caller provided a config, honor its saved theme at startup.

        Silently ignores an unknown theme name so a stale config doesn't
        crash the TUI — the user can just pick a new one."""
        config = self.tui_ctx.config
        if config is None:
            return
        saved = getattr(getattr(config, "ui", None), "theme", None)
        if not saved:
            return
        if saved in self.available_themes:
            self.theme = saved

    # ---- settings modal ---------------------------------------------------

    def action_open_settings(self) -> None:
        if self.tui_ctx.paths is None or self.tui_ctx.config is None:
            self.notify("Settings are unavailable in this session.", severity="warning")
            return
        self.run_worker(self._open_settings_flow(), group="settings", exclusive=False)

    async def _open_settings_flow(self) -> None:
        assert self.tui_ctx.paths is not None and self.tui_ctx.config is not None
        result = await self.push_screen_wait(SettingsModal(self.tui_ctx.paths, self.tui_ctx.config))
        if result is not None:
            self._apply_saved_config(result)

    def action_edit_prompts(self) -> None:
        if self.tui_ctx.paths is None:
            self.notify("Prompt library is unavailable in this session.", severity="warning")
            return
        self.push_screen(PromptLibraryModal(self.tui_ctx.paths))

    # ---- hide-done --------------------------------------------------------

    def action_toggle_done_visibility(self) -> None:
        """Flip the backlog's show/hide for resolved + closed items.

        Persists the new value to config.toml so the choice survives
        relaunches. Falls back gracefully if paths/config aren't wired
        (pilot tests, read-only sessions)."""
        self.tui_ctx.hide_done = not self.tui_ctx.hide_done
        # Persist to config so the next launch opens with the same setting.
        cfg = self.tui_ctx.config
        paths = self.tui_ctx.paths
        if cfg is not None and paths is not None:
            cfg.ui.hide_done = self.tui_ctx.hide_done
            with contextlib.suppress(Exception):
                save_config(paths, cfg)
        # Re-run the active search (if any) so the toggle respects the current
        # filter input rather than silently dropping it.
        try:
            filter_input = self.query_one("#filter", Input)
        except Exception:
            self._reload_tree()
        else:
            self._apply_filter(filter_input.value or "")
        label = "hidden" if self.tui_ctx.hide_done else "visible"
        self.notify(f"Done items {label}.", severity="information")

    # ---- default provider -------------------------------------------------

    def action_set_default_provider(self) -> None:
        """Persist the current provider as `config.active_provider`.

        Writes the full config back to `config.toml` via `save_config` so the
        choice sticks across launches. Pilot tests that mount the TUI without
        `paths`/`config` get a warning toast instead of a crash."""
        config = self.tui_ctx.config
        paths = self.tui_ctx.paths
        key = self.tui_ctx.provider_key
        if config is None or paths is None:
            self.notify(
                "Can't persist default provider — config paths not wired.",
                severity="warning",
            )
            return
        if not key or key not in config.providers:
            self.notify("No active provider to pin as default.", severity="warning")
            return
        if config.active_provider == key:
            entry = config.providers[key]
            self.notify(
                f"'{entry.display_name}' is already the default provider.",
                severity="information",
            )
            return
        config.active_provider = key
        try:
            save_config(paths, config)
        except Exception as e:
            self.notify(humanize_error(e, action="Save config"), severity="error")
            return
        entry = config.providers[key]
        self.notify(
            f"Default provider set to '{entry.display_name}'. Opens here on next launch.",
            severity="information",
        )

    # ---- apply saved config ------------------------------------------------

    def _apply_saved_config(self, config: Config) -> None:
        """Update the in-memory settings after the modal persists config.toml.

        Display and form behavior can refresh in-session. Provider wiring and
        recurring timers are read at startup, so those changes take effect on
        the next app launch.
        """
        self.tui_ctx.config = config
        self.tui_ctx.compaction_threshold_tokens = config.llm.compaction_threshold_tokens
        self.tui_ctx.external_watch_interval_seconds = config.llm.external_watch_interval_seconds
        self.tui_ctx.background_sync_interval_seconds = config.sync.background_interval_seconds
        self.tui_ctx.background_sync_min_interval_by_provider = dict(
            config.sync.min_interval_seconds_by_provider
        )
        self.tui_ctx.stale_threshold_days = config.stale.threshold_days
        self.tui_ctx.stale_threshold_by_provider = dict(config.stale.threshold_days_by_provider)
        self.tui_ctx.default_new_item_kind = ItemKind(config.ui.default_new_item_kind)
        self.tui_ctx.show_acceptance_criteria = config.ui.show_acceptance_criteria
        self.tui_ctx.hide_done = config.ui.hide_done
        self.query_one(ItemTree).stale_threshold_days = self._resolved_stale_threshold()
        self.query_one(ChatPane).set_show_acceptance_criteria(config.ui.show_acceptance_criteria)
        entry = (
            config.providers.get(self.tui_ctx.provider_key) if self.tui_ctx.provider_key else None
        )
        if entry is not None and entry.active_scope in entry.scopes:
            self.action_switch_view(entry.active_scope)
        else:
            self._reload_tree()
        self.notify(
            "Settings saved. View and prompt behavior updated now; provider and timer changes apply on the next launch.",
            severity="information",
        )


__all__ = ["ConfigMixin"]
