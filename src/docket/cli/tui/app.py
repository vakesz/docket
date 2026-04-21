from __future__ import annotations

import contextlib
import logging
import traceback
import webbrowser
from dataclasses import dataclass
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.command import Provider
from textual.containers import Horizontal, Vertical
from textual.widget import Widget
from textual.widgets import Footer, Header, Input, Static

from docket.agent.foundry_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage, StreamDelta
from docket.cli.tui.widgets.chat_pane import ChatPane, UserTurnRequest
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemSelected, ItemTree
from docket.cli.tui.widgets.quick_open import QuickOpenModal, QuickOpenResult
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.cli.tui.widgets.theme_picker import ThemePicker
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.model import ScopeFilters
from docket.core.services import (
    conversation_service,
    external_update_service,
    mutation_service,
    suggestion_service,
    sync_service,
)
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.suggestion_service import Suggestion, SuggestionError
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, conversation_repo, item_repo, search_repo

log = logging.getLogger(__name__)


class Pane(Vertical):
    """A resizable/maximizable container used for each of the three panes.

    `Vertical.allow_maximize` is a read-only property in this Textual version,
    so we subclass to flip the class-level flag rather than assign per-instance.
    Every pane shares a single muted border; the `:focus-within` pseudo-class
    swaps it for an accent border so the active pane is obvious when tabbing.
    """

    allow_maximize = True

    DEFAULT_CSS = """
    Pane {
        border: round $panel-lighten-2;
        padding: 0;
    }
    Pane:focus-within {
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
        dock: top;
        height: 1;
        background: transparent;
        color: $text-muted;
        content-align-horizontal: right;
        padding: 0 1;
    }
    FullscreenToggle:hover {
        color: $accent;
        text-style: bold;
    }
    """

    GLYPH_MAXIMIZE = "⤢"
    GLYPH_MINIMIZE = "⤡"

    def __init__(self) -> None:
        super().__init__(self.GLYPH_MAXIMIZE)

    def on_click(self) -> None:
        pane: Widget | None = self.parent if isinstance(self.parent, Widget) else None
        while pane is not None and not isinstance(pane, Pane):
            pane = pane.parent if isinstance(pane.parent, Widget) else None
        if pane is None:
            return
        app = self.app
        screen = self.screen
        if screen.maximized is not None:
            screen.minimize()
            if isinstance(app, ItvApp):
                app.restore_pane_widths()
        else:
            if isinstance(app, ItvApp):
                app.clear_pane_width_override(pane)
            screen.maximize(pane)
        if isinstance(app, ItvApp):
            app.sync_fullscreen_icons()


@dataclass
class TuiContext:
    """What the TUI needs from the caller to run. Kept small so the app can be mounted
    from production code (via Context) and from pilot-style tests (via fakes)."""

    conn: object  # sqlite3.Connection (avoid heavy typing imports here)
    provider: WorkItemProvider
    scope: ScopeFilters
    scope_key: str = "default"
    llm: LlmClient | None = None  # None disables chat (useful for pre-M4 tests)
    compaction_threshold_tokens: int = 0  # 0 disables — passed to conversation_service
    external_watch_interval_seconds: float = 60.0  # 0 disables external-update watcher
    # Optional handles for features that persist to config (theme picker, etc).
    # Pilot tests can leave these as None; persistence becomes a no-op.
    paths: Paths | None = None
    config: Config | None = None


def _docket_commands_provider() -> type[Provider]:
    """Lazy loader for the Docket command-palette provider.

    Imported this way because `commands.py` imports `ItvApp` under
    `TYPE_CHECKING`, so a top-level import here would be circular."""
    from docket.cli.tui.commands import DocketCommands

    return DocketCommands


class ItvApp(App[None]):
    """Three-pane terminal UI for browsing and triaging work items."""

    # Extend the default palette (theme/quit) with Docket actions. `App.COMMANDS`
    # is a set of provider classes (or callables returning one); we union in ours
    # so the built-ins stay available.
    COMMANDS = App.COMMANDS | {_docket_commands_provider}

    CSS = """
    #main { height: 1fr; }
    /* Widths are scoped to the normal three-pane layout so Textual's
       maximize view (which reparents the widget) isn't constrained. */
    #main > #left  { width: 35%; }
    #main > #mid   { width: 40%; }
    #main > #right { width: 25%; }
    Pane.-maximized { width: 100%; height: 100%; }
    #filter { dock: top; height: 1; border: none; padding: 0 1; background: $surface; }
    """

    BINDINGS: ClassVar[list[Binding | tuple[str, str] | tuple[str, str, str]]] = [
        Binding("q", "quit", "Quit", priority=True),
        Binding("r", "refresh", "Refresh"),
        Binding("slash", "focus_filter", "Filter"),
        Binding("question_mark", "show_help", "Help"),
        Binding("t", "new_thread", "New thread"),
        Binding("d", "review_pending", "Review pending"),
        Binding("o", "open_in_browser", "Open in browser"),
        Binding("s", "suggest_next", "Suggest next action"),
        Binding("ctrl+f", "toggle_fullscreen", "Fullscreen pane"),
        Binding("ctrl+left", "shrink_pane", "Shrink pane"),
        Binding("ctrl+right", "grow_pane", "Grow pane"),
        Binding("colon", "quick_open", "Quick-open by id"),
        Binding("ctrl+t", "pick_theme", "Theme"),
    ]

    # Initial pane widths (percentages). Resize actions mutate these.
    _PANE_IDS: ClassVar[tuple[str, ...]] = ("left", "mid", "right")
    _DEFAULT_PANE_PCT: ClassVar[dict[str, int]] = {"left": 35, "mid": 40, "right": 25}

    def __init__(self, tui_ctx: TuiContext) -> None:
        super().__init__()
        self.tui_ctx = tui_ctx
        self.title = "Docket"
        self._selected_item_id: str | None = None
        self._proposals = ProposalStore()
        self._agent: AgentLoop | None = None
        self._pane_pct: dict[str, int] = dict(self._DEFAULT_PANE_PCT)
        if tui_ctx.llm is not None:
            registry = ToolRegistry()
            register_readonly_tools(registry, conn=tui_ctx.conn, provider=tui_ctx.provider)  # type: ignore[arg-type]
            register_mutating_tools(
                registry,
                conn=tui_ctx.conn,  # type: ignore[arg-type]
                store=self._proposals,
                active_item=lambda: self._selected_item_id,
            )
            self._agent = AgentLoop(client=tui_ctx.llm, tools=registry)

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            with Pane(id="left"):
                yield FullscreenToggle()
                yield Input(placeholder="filter (/) — title, description, comments…", id="filter")
                yield ItemTree(id="tree")
            with Pane(id="mid"):
                yield FullscreenToggle()
                yield ItemDetail(id="mid-detail")
            with Pane(id="right"):
                yield FullscreenToggle()
                yield ChatPane(id="right-chat")
        yield StatusBar(id="status")
        yield Footer()

    def on_mount(self) -> None:
        self._reload_tree()
        self._init_status_bar()
        self._apply_saved_theme()
        if self.tui_ctx.external_watch_interval_seconds > 0:
            self.set_interval(
                self.tui_ctx.external_watch_interval_seconds,
                self._tick_external_watch,
                name="external-watch",
            )

    def _tick_external_watch(self) -> None:
        """Runs on the Textual event loop every N seconds. Spawns a worker per
        tick so the provider call doesn't block the UI. No-op when no item is
        selected."""
        item_id = self._selected_item_id
        if item_id is None:
            return
        self.run_worker(
            lambda iid=item_id: self._external_watch_once(iid),
            group=f"external-watch-{item_id}",
            exclusive=True,
            thread=True,
        )

    def _external_watch_once(self, item_id: str) -> None:
        try:
            result = external_update_service.check_and_inject(
                self.tui_ctx.conn,  # type: ignore[arg-type]
                self.tui_ctx.provider,
                item_id,
            )
        except Exception:
            # External updates are a nice-to-have; a provider hiccup shouldn't
            # break the session. We log and move on.
            log.exception("external-update poll failed for %s", item_id)
            return
        if not result.changed:
            return

        def apply() -> None:
            # Guard: the user may have switched items between the worker
            # starting and this callback firing.
            if self._selected_item_id != item_id:
                return
            fresh_item = item_repo.get_item(self.tui_ctx.conn, item_id)  # type: ignore[arg-type]
            fresh_comments = comment_repo.list_comments(self.tui_ctx.conn, item_id)  # type: ignore[arg-type]
            self.query_one(ItemDetail).show(fresh_item, fresh_comments)
            chat = self.query_one(ChatPane)
            chat.note(
                f"external update · {result.diff.splitlines()[0] if result.diff else 'metadata changed'}",
                cls="msg-system",
            )
            self.notify(
                f"{item_id} updated externally",
                severity="information",
            )

        self.call_from_thread(apply)

    def _reload_tree(self) -> None:
        items = item_repo.list_items(self.tui_ctx.conn)  # type: ignore[arg-type]
        self.query_one(ItemTree).load_items(items)

    def _init_status_bar(self) -> None:
        """Populate the static status-bar segments (provider name, scope key).

        Dynamic segments (last-sync, offline, streaming, cost, read-only) are
        updated elsewhere — here we just put the right initial values up so
        the bar doesn't render with em-dashes on first paint."""
        try:
            bar = self.query_one(StatusBar)
        except Exception:
            return
        provider = self.tui_ctx.provider
        display = getattr(provider, "display_name", None) or type(provider).__name__
        bar.provider_name = str(display)
        bar.scope_label = self.tui_ctx.scope_key

    def on_item_selected(self, message: ItemSelected) -> None:
        item = item_repo.get_item(self.tui_ctx.conn, message.item_id)  # type: ignore[arg-type]
        comments = comment_repo.list_comments(self.tui_ctx.conn, message.item_id)  # type: ignore[arg-type]
        self.query_one(ItemDetail).show(item, comments)
        chat = self.query_one(ChatPane)
        chat.bind_item(item)
        self._selected_item_id = item.id if item else None
        if item is not None:
            active = conversation_repo.get_active_for_item(self.tui_ctx.conn, item.id)  # type: ignore[arg-type]
            if active is None:
                chat.show_history([])
            else:
                history = conversation_service.history(self.tui_ctx.conn, active.id)  # type: ignore[arg-type]
                chat.show_history(history)
            # Fetch fresh details (attachments, up-to-date description, comments)
            # from the provider in the background — the WIQL sync batch can't carry
            # relations, so attachments only show up after this hydrates.
            self.run_worker(
                lambda item_id=item.id: self._hydrate_detail(item_id),
                group=f"hydrate-{item.id}",
                exclusive=True,
                thread=True,
            )

    def _hydrate_detail(self, item_id: str) -> None:
        try:
            fresh = self.tui_ctx.provider.get_item(item_id)
            fresh_comments = self.tui_ctx.provider.get_comments(item_id)
        except Exception:
            log.exception("detail hydrate failed for %s", item_id)
            return
        item_repo.upsert_item(self.tui_ctx.conn, fresh)  # type: ignore[arg-type]
        comment_repo.replace_comments_for_item(self.tui_ctx.conn, item_id, fresh_comments)  # type: ignore[arg-type]
        # Only repaint if the user hasn't moved on to another item.
        def paint() -> None:
            if self._selected_item_id == item_id:
                self.query_one(ItemDetail).show(fresh, fresh_comments)
        self.call_from_thread(paint)

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "filter":
            return
        self._apply_filter(event.value or "")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        # Enter in the filter is redundant with the live-filter path, but we
        # still honor it so nothing feels broken and pilot tests that drive
        # `action_submit` continue to work.
        if event.input.id != "filter":
            return
        self._apply_filter(event.value or "")

    def _apply_filter(self, raw: str) -> None:
        """Re-render the tree for the given filter query.

        Empty query = full list (same as _reload_tree). Non-empty delegates
        to the FTS5-backed search_repo so title + description + comments all
        match, returning items in bm25 rank order."""
        query = raw.strip()
        tree = self.query_one(ItemTree)
        if not query:
            tree.load_items(item_repo.list_items(self.tui_ctx.conn))  # type: ignore[arg-type]
            return
        ids = search_repo.search(self.tui_ctx.conn, query)  # type: ignore[arg-type]
        if not ids:
            tree.load_items([])
            return
        by_id = {i.id: i for i in item_repo.list_items(self.tui_ctx.conn)}  # type: ignore[arg-type]
        tree.load_items([by_id[iid] for iid in ids if iid in by_id])

    def on_user_turn_request(self, event: UserTurnRequest) -> None:
        """User submitted text in the chat pane — drive the agent turn."""
        if self._agent is None or self._selected_item_id is None:
            self.query_one(ChatPane).note("Chat is not configured.", cls="msg-system")
            return
        item_id = self._selected_item_id
        text = event.text
        self.run_worker(
            lambda: self._run_turn(item_id, text),
            group="chat",
            exclusive=True,
            thread=True,
        )

    def _run_turn(self, item_id: str, text: str) -> None:
        chat = self.query_one(ChatPane)
        assert self._agent is not None  # guarded by on_user_turn_request

        def on_delta(delta: StreamDelta) -> None:
            self.call_from_thread(chat.append_delta, delta)

        def on_message(msg: ChatMessage) -> None:
            if msg.role == "assistant" and msg.content:
                # Final (or intermediate) assistant text already streamed via delta.
                return
            if msg.role == "assistant" and msg.tool_calls:
                names = ", ".join(tc.name for tc in msg.tool_calls)
                self.call_from_thread(chat.note, f"→ calling {names}")
            elif msg.role == "tool":
                preview = (msg.content or "")[:80].replace("\n", " ")
                self.call_from_thread(chat.note, f"← {msg.name}: {preview}")

        # Begin the assistant bubble before deltas arrive.
        self.call_from_thread(chat.begin_assistant)
        try:
            result = conversation_service.send_user_message(
                self.tui_ctx.conn,  # type: ignore[arg-type]
                self._agent,
                item_id,
                text,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=self.tui_ctx.compaction_threshold_tokens or None,
            )
        except Exception as e:
            log.exception("chat turn failed")
            detail = f"{type(e).__name__}: {e}".strip()
            body = getattr(getattr(e, "response", None), "text", None)
            if body:
                detail = f"{detail} — {body[:200]}"
            self.call_from_thread(chat.note, f"chat failed: {detail}", cls="msg-system")
            self.call_from_thread(chat.note, traceback.format_exc().splitlines()[-1], cls="msg-system")
            return
        self.call_from_thread(chat.finish_turn, result.usage)
        # If the turn produced pending proposals, surface the first one.
        if len(self._proposals) > 0:
            self.call_from_thread(self._open_next_pending)

    def action_refresh(self) -> None:
        self.notify("Syncing from Azure DevOps…")
        try:
            summary = sync_service.refresh(
                self.tui_ctx.conn,  # type: ignore[arg-type]
                self.tui_ctx.provider,
                self.tui_ctx.scope_key,
                self.tui_ctx.scope,
            )
        except Exception as e:  # provider failure → toast, not crash
            self.notify(f"Sync failed: {e}", severity="error")
            self._set_offline(True)
            return
        self._set_offline(False)
        self._mark_sync_now()
        self._reload_tree()
        self.notify(
            f"Synced {summary.upserted}, archived {summary.archived}",
            severity="information",
        )

    def _mark_sync_now(self) -> None:
        with contextlib.suppress(Exception):
            self.query_one(StatusBar).set_last_sync_now()

    def _set_offline(self, offline: bool) -> None:
        with contextlib.suppress(Exception):
            self.query_one(StatusBar).offline = offline

    def action_focus_filter(self) -> None:
        self.query_one("#filter", Input).focus()

    def action_toggle_fullscreen(self) -> None:
        """Maximize the pane that holds the currently-focused widget; if a
        pane is already maximized, minimize back to the three-pane layout."""
        screen = self.screen
        if screen.maximized is not None:
            screen.minimize()
            self.restore_pane_widths()
            self.sync_fullscreen_icons()
            return
        pane = self._focused_pane()
        if pane is None:
            self.notify("Focus a pane first.", severity="warning")
            return
        self.clear_pane_width_override(pane)
        screen.maximize(pane)
        self.sync_fullscreen_icons()

    def clear_pane_width_override(self, pane: Widget) -> None:
        """Drop any inline width set by ctrl+[/] resizes so the pane can
        actually expand to fill the maximize layer."""
        pane.styles.width = None

    def restore_pane_widths(self) -> None:
        """Re-apply the user's resize preferences after leaving fullscreen."""
        for pid, pct in self._pane_pct.items():
            with contextlib.suppress(Exception):
                self.query_one(f"#{pid}", Widget).styles.width = f"{pct}%"

    def sync_fullscreen_icons(self) -> None:
        """Flip each pane's ⤢ glyph to ⤡ while that pane is maximized.

        Called after Ctrl+F and after clicking a FullscreenToggle so the
        visible button reflects the current screen state."""
        maximized = self.screen.maximized
        for toggle in self.query(FullscreenToggle):
            owner: Widget | None = toggle.parent if isinstance(toggle.parent, Widget) else None
            while owner is not None and not isinstance(owner, Pane):
                owner = owner.parent if isinstance(owner.parent, Widget) else None
            if owner is not None and owner is maximized:
                toggle.update(FullscreenToggle.GLYPH_MINIMIZE)
            else:
                toggle.update(FullscreenToggle.GLYPH_MAXIMIZE)

    def action_shrink_pane(self) -> None:
        self._resize_focused_pane(-5)

    def action_grow_pane(self) -> None:
        self._resize_focused_pane(+5)

    def _focused_pane(self) -> Widget | None:
        """Walk up the focused widget's ancestors until we hit one of the
        three named panes. Returns None if nothing is focused."""
        node: Widget | None = self.focused
        while node is not None:
            if isinstance(node.id, str) and node.id in self._PANE_IDS:
                return node
            node = node.parent if isinstance(node.parent, Widget) else None
        return None

    def _resize_focused_pane(self, delta_pct: int) -> None:
        """Bump the focused pane's width by delta_pct, taking the offset from
        its right neighbor (or left, if it's the rightmost pane). Each pane
        is clamped to 10-80% so nothing can collapse to zero or monopolize
        the layout."""
        pane = self._focused_pane()
        if pane is None:
            return
        pane_id = pane.id
        if pane_id not in self._pane_pct:
            return
        order = list(self._PANE_IDS)
        idx = order.index(pane_id)
        neighbor_id = order[idx + 1] if idx + 1 < len(order) else order[idx - 1]

        cur = self._pane_pct[pane_id]
        neighbor_cur = self._pane_pct[neighbor_id]
        new_cur = max(10, min(80, cur + delta_pct))
        applied = new_cur - cur
        new_neighbor = neighbor_cur - applied
        if new_neighbor < 10 or new_neighbor > 80:
            return
        self._pane_pct[pane_id] = new_cur
        self._pane_pct[neighbor_id] = new_neighbor
        self.query_one(f"#{pane_id}", Widget).styles.width = f"{new_cur}%"
        self.query_one(f"#{neighbor_id}", Widget).styles.width = f"{new_neighbor}%"

    def action_quick_open(self) -> None:
        """Prompt for a ticket id; on submit, route through the normal
        item-selection path so detail + chat wire up the same way as if
        the user clicked the row in the tree."""

        def on_result(result: QuickOpenResult | None) -> None:
            if result is None or result.item_id is None:
                return
            item = item_repo.get_item(self.tui_ctx.conn, result.item_id)  # type: ignore[arg-type]
            if item is None:
                self.notify(f"No item '{result.item_id}' in cache.", severity="warning")
                return
            # Reuse the tree's message path so on_item_selected runs unchanged.
            self.post_message(ItemSelected(item.id))

        self.push_screen(QuickOpenModal(conn=self.tui_ctx.conn), on_result)  # type: ignore[arg-type]

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

    def action_show_help(self) -> None:
        self.notify(
            "arrows navigate • Tab pane cycle • Enter open • Esc back • / filter • "
            "Ctrl+P palette • :id quick-open • Ctrl+F fullscreen pane • Ctrl+←/→ resize • "
            "Ctrl+T theme • o browser • r refresh • t new thread • d review pending • q quit",
            title="Keys",
        )

    def action_open_in_browser(self) -> None:
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        item = item_repo.get_item(self.tui_ctx.conn, self._selected_item_id)  # type: ignore[arg-type]
        if item is None or not item.url:
            self.notify("This item has no URL on file.", severity="warning")
            return
        webbrowser.open(item.url)
        self.notify(f"Opened {item.id} in browser")

    def action_new_thread(self) -> None:
        if self._selected_item_id is None:
            return
        conversation_service.new_thread(self.tui_ctx.conn, self._selected_item_id)  # type: ignore[arg-type]
        chat = self.query_one(ChatPane)
        chat.show_history([])
        chat.set_status("new thread started")

    def action_suggest_next(self) -> None:
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        if self.tui_ctx.llm is None:
            self.notify("Chat/LLM is disabled.", severity="warning")
            return
        item_id = self._selected_item_id
        self.notify("Thinking about the next action…")
        self.run_worker(
            lambda iid=item_id: self._run_suggestion(iid),
            group="suggestion",
            exclusive=True,
            thread=True,
        )

    def _run_suggestion(self, item_id: str) -> None:
        item = item_repo.get_item(self.tui_ctx.conn, item_id)  # type: ignore[arg-type]
        if item is None:
            self.call_from_thread(self.notify, f"Item {item_id} is gone.", severity="error")
            return
        try:
            suggestion = suggestion_service.suggest_next_action(
                self.tui_ctx.conn,  # type: ignore[arg-type]
                self.tui_ctx.llm,  # type: ignore[arg-type]
                item,
            )
        except SuggestionError as e:
            self.call_from_thread(self.notify, f"Suggestion failed: {e}", severity="error")
            return
        except Exception as e:
            log.exception("suggestion failed for %s", item_id)
            self.call_from_thread(self.notify, f"Suggestion failed: {e}", severity="error")
            return
        self.call_from_thread(self._show_suggestion_modal, suggestion)

    def _show_suggestion_modal(self, suggestion: Suggestion) -> None:
        def on_decision(accepted: bool | None) -> None:
            if not accepted:
                self.notify("Suggestion dismissed.", severity="information")
                return
            try:
                staged = suggestion_service.stage_suggestion(
                    self.tui_ctx.conn,  # type: ignore[arg-type]
                    suggestion,
                )
            except Exception as e:
                self.notify(f"Failed to stage: {e}", severity="error")
                return
            self._proposals.add(staged.state_change, source="suggestion")
            if staged.description_patch is not None:
                self._proposals.add(staged.description_patch, source="suggestion")
            self.notify(
                f"Staged {1 if staged.description_patch is None else 2} proposal(s); "
                "press 'd' to review.",
                severity="information",
            )
            self._open_next_pending()

        self.push_screen(SuggestionModal(suggestion), on_decision)

    def action_review_pending(self) -> None:
        if len(self._proposals) == 0:
            self.notify("No pending proposals.", severity="information")
            return
        self._open_next_pending()

    def _open_next_pending(self) -> None:
        pending = self._proposals.peek_next()
        if pending is None:
            return

        def on_decision(confirmed: bool | None) -> None:
            # peek_next did not remove; we drain here.
            popped = self._proposals.pop(pending.proposal.id)
            if popped is None:
                return
            if not confirmed:
                self.notify("Rejected.", severity="warning")
                return
            try:
                result = mutation_service.confirm(
                    self.tui_ctx.conn,  # type: ignore[arg-type]
                    self.tui_ctx.provider,
                    popped.proposal,
                )
            except Exception as e:
                self.notify(f"Apply failed: {e}", severity="error")
                return
            self._reload_tree()
            if result.attachment_url:
                self.notify(f"Uploaded → {result.attachment_url}", severity="information")
            elif result.item is not None:
                self.notify(f"Applied · {result.item.id} now {result.item.state.value}")
            else:
                self.notify("Applied.")
            # Chain-drain: if more pending, pop up the next modal.
            if len(self._proposals) > 0:
                self._open_next_pending()

        self.push_screen(DiffModal(pending.proposal, source=pending.source), on_decision)
