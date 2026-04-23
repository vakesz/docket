from __future__ import annotations

import contextlib
import logging
import webbrowser
from collections.abc import Callable
from typing import ClassVar

from textual import events
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.command import Provider
from textual.containers import Horizontal
from textual.widgets import Input, Static

from docket.agent.factory import build_agent
from docket.agent.loop import AgentLoop
from docket.agent.types import ChatMessage, StreamDelta
from docket.cli.tui.background_tasks import BackgroundTasksMixin
from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.errors import retry_hint
from docket.cli.tui.pane_layout import PaneLayoutMixin
from docket.cli.tui.panes import FullscreenToggle, Pane
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.widgets.batch_diff_modal import BatchDecision, BatchDiffModal
from docket.cli.tui.widgets.chat_pane import ChatPane, TurnFinished, UserTurnRequest
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.help_modal import HelpModal
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemSelected, ItemTree
from docket.cli.tui.widgets.mcp_pane import MCPPane
from docket.cli.tui.widgets.memory_pane import MemoryPane
from docket.cli.tui.widgets.new_item_modal import NewItemModal, NewItemRequest
from docket.cli.tui.widgets.prompt_library import PromptLibraryModal
from docket.cli.tui.widgets.quick_open import QuickOpenModal, QuickOpenResult
from docket.cli.tui.widgets.settings_modal import SettingsModal
from docket.cli.tui.widgets.source_pane import SourcePane
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.cli.tui.widgets.theme_picker import ThemePicker
from docket.config import save_config
from docket.config.models import Config, ProviderEntry
from docket.core.model import (
    ItemKind,
    ItemState,
    TransitionIntent,
    project_id_for,
)
from docket.core.services import (
    conversation_service,
    mutation_service,
    suggestion_service,
    sync_service,
    visual_filter,
)
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.suggestion_service import Suggestion, SuggestionError
from docket.providers import registry
from docket.providers.base import GroupingStrategy
from docket.storage.repos import (
    comment_repo,
    conversation_repo,
    item_repo,
    search_repo,
    watchlist_repo,
)

log = logging.getLogger(__name__)


def _docket_commands_provider() -> type[Provider]:
    """Lazy loader for the Docket command-palette provider.

    Imported this way because `commands.py` imports `DocketApp` under
    `TYPE_CHECKING`, so a top-level import here would be circular."""
    from docket.cli.tui.commands import DocketCommands

    return DocketCommands


class DocketApp(BackgroundTasksMixin, PaneLayoutMixin, App[None]):
    """Three-pane terminal UI for browsing and triaging work items."""

    # Replace the default palette providers entirely: Textual's built-in theme
    # command (a) doesn't live-preview on highlight and (b) bypasses our
    # config.ui.theme persistence. Users still get quit/help via keybinds.
    COMMANDS: ClassVar[set[type[Provider] | Callable[[], type[Provider]]]] = {
        _docket_commands_provider
    }

    CSS = """
    Screen {
        background: $panel;
        color: $text;
    }
    ModalScreen {
        background: $background 60%;
    }
    #main {
        height: 1fr;
        padding: 0 1 0 1;
        background: $panel;
    }
    /* Widths are scoped to the normal three-pane layout so Textual's
       maximize view (which reparents the widget) isn't constrained. */
    #main > #left  { width: 31%; }
    #main > #mid   { width: 41%; }
    #main > #right { width: 28%; }
    Pane.-maximized { width: 100%; height: 100%; }
    .pane-heading {
        height: auto;
        padding: 1 2 1 2;
        color: $text;
        text-style: bold;
        background: transparent;
    }
    #filter {
        height: 3;
        border: round $panel-lighten-1;
        margin: 0 2 1 2;
        padding: 0 1;
        background: $boost;
        color: $text;
    }
    #filter:focus {
        border: round $accent;
    }
    """

    BINDINGS: ClassVar[list[Binding | tuple[str, str] | tuple[str, str, str]]] = [
        Binding("q", "quit", "Quit", priority=True, show=False),
        Binding("r", "refresh", "Refresh", show=False),
        Binding("slash", "focus_filter", "Filter"),
        Binding("question_mark", "show_help", "Help"),
        Binding("f1", "show_help", "Help", show=False),
        Binding("h", "show_help", "Help", show=False),
        Binding("t", "new_thread", "New thread", show=False),
        Binding("n", "new_item", "New item", show=False),
        Binding("d", "review_pending", "Review pending", show=False),
        Binding("o", "open_in_browser", "Open in browser", show=False),
        Binding("s", "suggest_next", "Suggest next action", show=False),
        Binding("w", "toggle_pin", "Pin/unpin item", show=False),
        Binding("c", "toggle_done_visibility", "Show/hide done", show=False),
        Binding("comma", "open_settings", "Settings"),
        Binding("p", "edit_prompts", "Prompts"),
        Binding("m", "open_memory", "Memory", show=False),
        Binding("u", "open_source", "Sources", show=False),
        Binding("M", "open_mcp", "MCP", show=False),
        Binding("ctrl+f", "toggle_fullscreen", "Fullscreen pane", show=False),
        Binding("ctrl+left", "shrink_pane", "Shrink pane", show=False),
        Binding("ctrl+right", "grow_pane", "Grow pane", show=False),
        Binding("colon", "quick_open", "Quick-open by id", show=False),
        Binding("ctrl+t", "pick_theme", "Theme"),
        # Tab cycles between the three pane focus targets (tree → detail →
        # chat input). Priority=True so the binding fires even when an Input
        # owns focus; show=False keeps the footer tidy.
        Binding("tab", "focus_next_pane", "Next pane", show=False, priority=True),
        Binding("shift+tab", "focus_prev_pane", "Prev pane", show=False, priority=True),
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
            self._agent = build_agent(
                llm=tui_ctx.llm,
                conn=tui_ctx.conn,
                provider=tui_ctx.provider,
                store=self._proposals,
                active_item=lambda: self._selected_item_id,
                read_only=tui_ctx.read_only,
                provider_key=tui_ctx.provider_key,
                project_id=project_id_for(tui_ctx.provider_key),
                mcp_manager=tui_ctx.mcp_manager,
            )

    def compose(self) -> ComposeResult:
        with Horizontal(id="main"):
            with Pane(id="left"):
                yield FullscreenToggle()
                yield Static("Backlog", classes="pane-heading")
                yield Input(placeholder="Search backlog…  (: to open by id)", id="filter")
                yield ItemTree(
                    id="tree",
                    stale_threshold_days=self._resolved_stale_threshold(),
                    grouping=self._resolved_grouping(),
                )
            with Pane(id="mid"):
                yield FullscreenToggle()
                yield Static("Details", classes="pane-heading")
                yield ItemDetail(
                    id="mid-detail",
                    stale_threshold_days=self._resolved_stale_threshold(),
                )
            with Pane(id="right"):
                yield FullscreenToggle()
                yield Static("Assistant", classes="pane-heading")
                yield ChatPane(
                    id="right-chat",
                    show_acceptance_criteria=self.tui_ctx.show_acceptance_criteria,
                )
        yield StatusBar(id="status")

    def on_mount(self) -> None:
        self._reload_tree()
        self._init_status_bar()
        self._apply_saved_theme()
        self._apply_tooltips()
        if self.tui_ctx.external_watch_interval_seconds > 0:
            self.set_interval(
                self.tui_ctx.external_watch_interval_seconds,
                self._tick_external_watch,
                name="external-watch",
            )
        sync_interval = self._resolved_sync_interval()
        if sync_interval > 0:
            self._schedule_next_sync(sync_interval)
            self.set_interval(
                sync_interval,
                self._tick_background_sync,
                name="background-sync",
            )

    def _active_view_filter(self) -> visual_filter.ResolvedFilter:
        """Resolve the active saved view into a post-cache filter.

        `@me` is asked of the active provider; scopes without a first-class
        SQL column (area/iteration/team) are applied in Python by
        `visual_filter.apply_to_items`."""
        return visual_filter.resolve(self.tui_ctx.scope, self.tui_ctx.provider)

    def _reload_tree(self) -> None:
        resolved = self._active_view_filter()
        items = item_repo.list_items(
            self.tui_ctx.conn,
            provider_key=self.tui_ctx.provider_key,
            assignee=resolved.assignee,
            states=self._list_item_states(),
        )
        items = visual_filter.apply_to_items(items, resolved)
        pinned = watchlist_repo.list_pinned_items(
            self.tui_ctx.conn, provider_key=self.tui_ctx.provider_key
        )
        self.query_one(ItemTree).load_items(
            items, pinned=pinned, grouping=self._resolved_grouping()
        )

    def _provider_key(self) -> str:
        """Key used to look up per-provider overrides (stale threshold,
        sync floor). Mirrors the status-bar rule: prefer `display_name`,
        fall back to the class name."""
        prov = self.tui_ctx.provider
        name = getattr(prov, "display_name", None) or type(prov).__name__
        return str(name)

    def _resolved_stale_threshold(self) -> int | None:
        """Global default, unless the active provider has its own override.
        Returns None when the marker is disabled so ItemTree can short-circuit."""
        per_provider = self.tui_ctx.stale_threshold_by_provider or {}
        value = per_provider.get(self._provider_key(), self.tui_ctx.stale_threshold_days)
        return value if value and value > 0 else None

    def _resolved_sync_interval(self) -> float:
        """Configured interval, clamped up to the per-provider floor (if any).

        0 means disabled — and we keep it disabled even if a floor is set,
        because the floor only protects an already-enabled timer from
        exceeding the provider's rate limit."""
        base = self.tui_ctx.background_sync_interval_seconds
        if base <= 0:
            return 0.0
        floors = self.tui_ctx.background_sync_min_interval_by_provider or {}
        floor = floors.get(self._provider_key(), 0.0)
        return max(base, floor)

    def _resolved_grouping(self) -> GroupingStrategy:
        """Grouping strategy declared by the active provider's spec.

        Falls back to `"by_kind"` when the config isn't available (pilot
        tests) or the provider's type id isn't registered — matches the
        legacy behavior so nothing regresses for Azure DevOps."""
        entry = self._active_provider_entry()
        if entry is None:
            return "by_kind"
        spec = registry.spec(entry.type)
        if spec is None:
            return "by_kind"
        return spec.grouping

    def _list_item_states(self) -> tuple[ItemState, ...] | None:
        """States to pass to `item_repo.list_items`. `None` means "no state
        filter" — for the 'show done' toggle — and matches the existing
        behavior when called without a `states=` argument."""
        if not self.tui_ctx.hide_done:
            return None
        return (
            ItemState.NEW,
            ItemState.ACTIVE,
            ItemState.BLOCKED,
            ItemState.NEEDS_INFO,
        )

    def _init_status_bar(self) -> None:
        """Populate the static status-bar segments (provider name, scope key).

        Dynamic segments (last sync, offline, thinking, pending, cost,
        read-only) are updated elsewhere — here we just put the right initial
        values up so the bar doesn't render with em-dashes on first paint."""
        try:
            bar = self.query_one(StatusBar)
        except Exception:
            return
        provider = self.tui_ctx.provider
        display = getattr(provider, "display_name", None) or type(provider).__name__
        bar.provider_name = str(display)
        bar.scope_label = self.tui_ctx.scope_key
        bar.active_view = self.tui_ctx.scope_key
        bar.project_name = self._resolve_project_name()
        bar.read_only = self.tui_ctx.read_only
        bar.pending_count = len(self._proposals)
        bar.tooltip = (
            "Session status: project, provider, active view, sync health, "
            "chat activity, pending proposals, cost, and read-only mode."
        )

    def _refresh_pending_count(self) -> None:
        """Push the current pending-proposal count into the status bar.

        Called after every mutation of `self._proposals` so the visible count
        matches reality without polling."""
        with contextlib.suppress(Exception):
            self.query_one(StatusBar).pending_count = len(self._proposals)

    def _set_thinking(self, value: bool) -> None:
        """Toggle the status-bar 'thinking…' segment. Safe from worker threads
        because reactive assignments are atomic."""
        with contextlib.suppress(Exception):
            self.query_one(StatusBar).thinking = value

    def _resolve_project_name(self) -> str:
        """Display name for the active project (= active provider), or empty
        string if no name has been configured yet (status bar will skip)."""
        cfg = self.tui_ctx.config
        if cfg is None:
            return ""
        pid = project_id_for(self.tui_ctx.provider_key)
        entry = cfg.projects.get(pid)
        return entry.name if entry else ""

    def _rebind_mcp_for_active_project(self) -> None:
        """Switch the MCP fleet to match the current project (= provider).

        Called from the provider switch handler before rebuilding the agent
        so the fresh `ToolRegistry` sees the new project's MCP tools. View
        switches are render-only and do not change the project, so they do
        not trigger this. No-op when MCP isn't wired (pilot tests, read-only
        sessions). MCP startup can be slow; failures are logged inside
        the manager and don't block the UI."""
        mgr = self.tui_ctx.mcp_manager
        cfg = self.tui_ctx.config
        if mgr is None or cfg is None:
            return
        pid = project_id_for(self.tui_ctx.provider_key)
        project = cfg.projects.get(pid)
        servers = dict(project.mcp) if project is not None else {}
        mgr.bind_project(pid, servers)

    def _apply_tooltips(self) -> None:
        with contextlib.suppress(Exception):
            self.query_one(
                "#filter", Input
            ).tooltip = "Filter by title, description, or comments. Press Enter to keep current results. Press : to jump directly to a ticket by id."
        for toggle in self.query(FullscreenToggle):
            toggle.tooltip = "Maximize or restore this pane."

    def on_item_selected(self, message: ItemSelected) -> None:
        item = item_repo.get_item(
            self.tui_ctx.conn, message.item_id, provider_key=self.tui_ctx.provider_key
        )
        comments = comment_repo.list_comments(
            self.tui_ctx.conn, message.item_id, provider_key=self.tui_ctx.provider_key
        )
        self.query_one(ItemDetail).show(item, comments)
        chat = self.query_one(ChatPane)
        chat.bind_item(item)
        self._selected_item_id = item.id if item else None
        self._reset_cost_display()
        if item is not None:
            active = conversation_repo.get_active_for_item(
                self.tui_ctx.conn,
                item.id,
                provider_key=self.tui_ctx.provider_key,
            )
            if active is None:
                chat.show_history([])
            else:
                history = conversation_service.history(self.tui_ctx.conn, active.id)
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
        if self.tui_ctx.provider_key:
            fresh.provider_key = self.tui_ctx.provider_key
        item_repo.upsert_item(self.tui_ctx.conn, fresh)
        comment_repo.replace_comments_for_item(
            self.tui_ctx.conn,
            item_id,
            fresh_comments,
            provider_key=self.tui_ctx.provider_key,
        )

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

    def on_key(self, event: events.Key) -> None:
        filter_input = self.query_one("#filter", Input)
        tree = self.query_one(ItemTree)
        if event.key == "escape" and self._defocus_chat_prompt():
            event.stop()
            event.prevent_default()
            return
        if event.key == "down" and self.focused is filter_input:
            self._move_from_filter_to_tree()
            event.stop()
            event.prevent_default()
            return
        if event.key == "up" and self.focused is tree and self._move_from_tree_to_filter():
            event.stop()
            event.prevent_default()

    def _apply_filter(self, raw: str) -> None:
        """Re-render the tree for the given filter query.

        Empty query = full list (same as _reload_tree). Non-empty delegates
        to the FTS5-backed search_repo so title + description + comments all
        match, returning items in bm25 rank order. The active view filter
        (assignee, area, iteration, team) is layered on top of the search
        hits so scope and free-text narrow together."""
        query = raw.strip()
        tree = self.query_one(ItemTree)
        pinned = watchlist_repo.list_pinned_items(
            self.tui_ctx.conn, provider_key=self.tui_ctx.provider_key
        )
        resolved = self._active_view_filter()
        grouping = self._resolved_grouping()
        states = self._list_item_states()
        if not query:
            items = item_repo.list_items(
                self.tui_ctx.conn,
                provider_key=self.tui_ctx.provider_key,
                assignee=resolved.assignee,
                states=states,
            )
            tree.load_items(
                visual_filter.apply_to_items(items, resolved),
                pinned=pinned,
                grouping=grouping,
            )
            return
        ids = search_repo.search(
            self.tui_ctx.conn,
            query,
            provider_key=self.tui_ctx.provider_key,
            assignee=resolved.assignee,
        )
        if not ids:
            tree.load_items([], pinned=pinned, grouping=grouping)
            return
        by_id = {
            i.id: i
            for i in item_repo.list_items(
                self.tui_ctx.conn,
                provider_key=self.tui_ctx.provider_key,
                assignee=resolved.assignee,
                states=states,
            )
        }
        ordered = [by_id[iid] for iid in ids if iid in by_id]
        tree.load_items(
            visual_filter.apply_to_items(ordered, resolved),
            pinned=pinned,
            grouping=grouping,
        )

    def _move_from_filter_to_tree(self) -> None:
        tree = self.query_one(ItemTree)
        tree.focus()
        if tree.cursor_node is not None and tree.cursor_line >= 0:
            tree.action_cursor_down()
            return
        first_item = tree.first_visible_item_node()
        if first_item is not None:
            tree.move_cursor(first_item, animate=False)

    def _move_from_tree_to_filter(self) -> bool:
        tree = self.query_one(ItemTree)
        first_item = tree.first_visible_item_node()
        if first_item is None:
            return False
        if tree.cursor_node is not first_item and tree.cursor_line > first_item.line:
            return False
        self.query_one("#filter", Input).focus()
        return True

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
        self.call_from_thread(self._set_thinking, True)
        try:
            result = conversation_service.send_user_message(
                self.tui_ctx.conn,
                self._agent,
                item_id,
                text,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=self.tui_ctx.compaction_threshold_tokens or None,
                provider_key=self.tui_ctx.provider_key,
                project_id=project_id_for(self.tui_ctx.provider_key),
            )
        except Exception as e:
            log.exception("chat turn failed")
            friendly = humanize_error(e, action="Chat")
            self.call_from_thread(
                chat.note,
                f"{friendly} (see logs for the full traceback)",
                cls="msg-system",
            )
            self.call_from_thread(self._set_thinking, False)
            return
        self.call_from_thread(chat.finish_turn, result.usage)
        self.call_from_thread(self._set_thinking, False)
        # If the turn produced pending proposals, surface the first one.
        if len(self._proposals) > 0:
            self.call_from_thread(self._refresh_pending_count)
            self.call_from_thread(self._open_next_pending)

    def action_refresh(self) -> None:
        self.notify(f"Syncing from {self.tui_ctx.provider_key or 'active provider'}…")
        try:
            summary = sync_service.refresh(
                self.tui_ctx.conn,
                self.tui_ctx.provider,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception as e:  # provider failure → toast, not crash
            self.notify(
                f"{humanize_error(e, action='Sync')} {retry_hint('r', 'sync')}",
                severity="error",
            )
            self._set_offline(True)
            return
        self._set_offline(False)
        self._mark_sync_now()
        self._reload_tree()
        self.notify(
            f"Synced {summary.upserted}, archived {summary.archived}",
            severity="information",
        )

    def action_full_refresh(self) -> None:
        provider_label = self.tui_ctx.provider_key or "active provider"
        self.notify(f"Running full sync for {provider_label}…")
        try:
            summary = sync_service.full_refresh(
                self.tui_ctx.conn,
                self.tui_ctx.provider,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception as e:  # provider failure → toast, not crash
            self.notify(
                f"{humanize_error(e, action='Full sync')} {retry_hint('r', 'sync')}",
                severity="error",
            )
            self._set_offline(True)
            return
        self._set_offline(False)
        self._mark_sync_now()
        self._reload_tree()
        self.notify(
            f"Full sync complete: {summary.upserted} cached, archived {summary.archived}",
            severity="information",
        )

    def action_focus_filter(self) -> None:
        self.query_one("#filter", Input).focus()

    def action_quick_open(self) -> None:
        """Prompt for a ticket id; on submit, route through the normal
        item-selection path so detail + chat wire up the same way as if
        the user clicked the row in the tree."""

        def on_result(result: QuickOpenResult | None) -> None:
            if result is None or result.item_id is None:
                return
            item = item_repo.get_item(
                self.tui_ctx.conn, result.item_id, provider_key=self.tui_ctx.provider_key
            )
            if item is None:
                self.notify(f"No item '{result.item_id}' in cache.", severity="warning")
                return
            # Reuse the tree's message path so on_item_selected runs unchanged.
            self.post_message(ItemSelected(item.id))

        self.push_screen(
            QuickOpenModal(conn=self.tui_ctx.conn, provider_key=self.tui_ctx.provider_key),
            on_result,
        )

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
        self.push_screen(HelpModal())

    def action_open_in_browser(self) -> None:
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        item = item_repo.get_item(
            self.tui_ctx.conn,
            self._selected_item_id,
            provider_key=self.tui_ctx.provider_key,
        )
        if item is None or not item.url:
            self.notify("This item has no URL on file.", severity="warning")
            return
        webbrowser.open(item.url)
        self.notify(f"Opened {item.id} in browser")

    def action_new_thread(self) -> None:
        if self._selected_item_id is None:
            return
        conversation_service.new_thread(
            self.tui_ctx.conn,
            self._selected_item_id,
            provider_key=self.tui_ctx.provider_key,
        )
        chat = self.query_one(ChatPane)
        chat.show_history([])
        chat.set_status("")
        self._reset_cost_display()

    def _reset_cost_display(self) -> None:
        """Zero the status-bar conversation-cost counter. Called on item
        switch and new-thread — each chat thread gets its own running total."""
        with contextlib.suppress(Exception):
            self.query_one(StatusBar).cost_cents = 0

    def on_turn_finished(self, event: TurnFinished) -> None:
        """Roll the per-turn cost into the status bar's cumulative counter
        so the user sees $ spent on the active conversation at a glance."""
        with contextlib.suppress(Exception):
            bar = self.query_one(StatusBar)
            bar.cost_cents = bar.cost_cents + event.cost_cents

    def action_toggle_pin(self) -> None:
        """Pin or unpin the focused item. Pins survive scope/view switches —
        they come from the `watchlist` table, joined on `items.id` at reload
        time, so archived rows drop out without any bookkeeping here."""
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        item_id = self._selected_item_id
        if watchlist_repo.is_pinned(
            self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key
        ):
            watchlist_repo.unpin(self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key)
            self.tui_ctx.conn.commit()
            self.notify(f"Unpinned {item_id}.", severity="information")
        else:
            watchlist_repo.pin(self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key)
            self.tui_ctx.conn.commit()
            self.notify(f"Pinned {item_id}.", severity="information")
        self._reload_tree()

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
        item = item_repo.get_item(
            self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key
        )
        if item is None:
            self.call_from_thread(self.notify, f"Item {item_id} is gone.", severity="error")
            return
        llm = self.tui_ctx.llm
        if llm is None:
            self.call_from_thread(self.notify, "Chat/LLM is disabled.", severity="warning")
            return
        try:
            suggestion = suggestion_service.suggest_next_action(
                self.tui_ctx.conn,
                llm,
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
            if self._blocked_read_only():
                return
            try:
                staged = suggestion_service.stage_suggestion(
                    self.tui_ctx.conn,
                    suggestion,
                    provider_key=self.tui_ctx.provider_key,
                )
            except Exception as e:
                self.notify(f"Failed to stage: {e}", severity="error")
                return
            self._proposals.add(staged.state_change, source="suggestion")
            if staged.description_patch is not None:
                self._proposals.add(staged.description_patch, source="suggestion")
            self._refresh_pending_count()
            self.notify(
                f"Staged {1 if staged.description_patch is None else 2} proposal(s); "
                "press 'd' to review.",
                severity="information",
            )
            self._open_next_pending()

        self.push_screen(SuggestionModal(suggestion), on_decision)

    def _blocked_read_only(self) -> bool:
        """Toast and return True if the user just tried to stage a mutation
        while the app is in read-only mode."""
        if self.tui_ctx.read_only:
            self.notify("Read-only mode — mutations disabled.", severity="warning")
            return True
        return False

    def action_new_item(self) -> None:
        """Open the new-ticket form. Submit routes through propose_create
        and the diff modal — same confirm gate as every other write."""
        if self._blocked_read_only():
            return

        def on_result(result: NewItemRequest | None) -> None:
            if result is None:
                return
            proposal = mutation_service.propose_create(result.kind, result.fields)
            self._proposals.add(proposal, source="form")
            self._refresh_pending_count()
            self._open_next_pending()

        self.push_screen(
            NewItemModal(
                self.tui_ctx.conn,
                default_kind=self.tui_ctx.default_new_item_kind,
                provider_key=self.tui_ctx.provider_key,
            ),
            on_result,
        )

    def action_open_settings(self) -> None:
        if self.tui_ctx.paths is None or self.tui_ctx.config is None:
            self.notify("Settings are unavailable in this session.", severity="warning")
            return

        def on_result(result: Config | None) -> None:
            if result is None:
                return
            self._apply_saved_config(result)

        self.push_screen(SettingsModal(self.tui_ctx.paths, self.tui_ctx.config), on_result)

    def action_edit_prompts(self) -> None:
        if self.tui_ctx.paths is None:
            self.notify("Prompt library is unavailable in this session.", severity="warning")
            return
        self.push_screen(PromptLibraryModal(self.tui_ctx.paths))

    def action_open_memory(self) -> None:
        """Open the per-project memory editor for the active project."""
        cfg = self.tui_ctx.config
        if cfg is None:
            self.notify("Memory is unavailable in this session.", severity="warning")
            return
        project_id = project_id_for(self.tui_ctx.provider_key)
        project_name = self._resolve_project_name() or project_id
        self.push_screen(
            MemoryPane(
                conn=self.tui_ctx.conn,
                project_id=project_id,
                project_name=project_name,
                read_only=self.tui_ctx.read_only,
            )
        )

    def action_open_source(self) -> None:
        """Open the per-project sources editor for the active project."""
        cfg = self.tui_ctx.config
        if cfg is None:
            self.notify("Sources are unavailable in this session.", severity="warning")
            return
        project_id = project_id_for(self.tui_ctx.provider_key)
        project_name = self._resolve_project_name() or project_id
        self.push_screen(
            SourcePane(
                conn=self.tui_ctx.conn,
                project_id=project_id,
                project_name=project_name,
                read_only=self.tui_ctx.read_only,
            )
        )

    def action_open_mcp(self) -> None:
        """Open the per-project MCP server editor for the active project.

        On dismiss, if the modal committed any change (Save / Delete), the
        live `MCPManager` has already been rebound — but the agent's tool
        registry was baked at build time, so rebuild the agent here so the
        next turn sees the fresh `mcp__<name>__*` set."""
        cfg = self.tui_ctx.config
        paths = self.tui_ctx.paths
        if cfg is None or paths is None:
            self.notify("MCP is unavailable in this session.", severity="warning")
            return
        project_id = project_id_for(self.tui_ctx.provider_key)
        project_name = self._resolve_project_name() or project_id

        def on_dismiss(changed: bool | None) -> None:
            if changed and self.tui_ctx.llm is not None:
                self._agent = build_agent(
                    llm=self.tui_ctx.llm,
                    conn=self.tui_ctx.conn,
                    provider=self.tui_ctx.provider,
                    store=self._proposals,
                    active_item=lambda: self._selected_item_id,
                    read_only=self.tui_ctx.read_only,
                    provider_key=self.tui_ctx.provider_key,
                    project_id=project_id_for(self.tui_ctx.provider_key),
                    mcp_manager=self.tui_ctx.mcp_manager,
                )

        self.push_screen(
            MCPPane(
                paths=paths,
                config=cfg,
                project_id=project_id,
                project_name=project_name,
                mcp_manager=self.tui_ctx.mcp_manager,
                read_only=self.tui_ctx.read_only,
            ),
            on_dismiss,
        )

    def action_transition(self, intent_value: str) -> None:
        """Stage a transition for the selected item and open the diff modal.

        Entry point for the command-palette transition commands. Lands in the
        same mutation pipeline as an agent tool-call — no shortcut around the
        confirm gate."""
        if self._blocked_read_only():
            return
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        try:
            intent = TransitionIntent(intent_value)
        except ValueError:
            self.notify(f"Unknown transition intent: {intent_value}", severity="error")
            return
        try:
            proposal = mutation_service.propose_transition(
                self.tui_ctx.conn,
                self._selected_item_id,
                intent,
                provider_key=self.tui_ctx.provider_key,
            )
        except KeyError as e:
            self.notify(humanize_error(e, action="Stage transition"), severity="error")
            return
        self._proposals.add(proposal, source="palette")
        self._refresh_pending_count()
        self._open_next_pending()

    def action_switch_view(self, name: str) -> None:
        """Switch the active saved view (= named scope filter) on the active provider.

        Views are visual filters over the cached set — switching one does
        **not** change the project, the MCP fleet, or the agent's tool
        registry. We just re-render the backlog with the new filter applied.
        This is what lets users peek at a teammate's queue without the chat
        pane losing its memory/sources/MCP context.

        In-memory only; persisting the active view requires editing the
        provider's `active_scope` in config.toml."""
        config = self.tui_ctx.config
        entry = self._active_provider_entry()
        if config is None or entry is None or name not in entry.scopes:
            self.notify(f"No saved view named '{name}'.", severity="warning")
            return
        self.tui_ctx.scope_key = name
        self.tui_ctx.scope = entry.scopes[name].to_core()
        with contextlib.suppress(Exception):
            bar = self.query_one(StatusBar)
            bar.scope_label = name
            bar.active_view = name
        self._reload_tree()
        self.notify(f"Switched to view '{name}'.", severity="information")

    def action_switch_provider(self, name: str) -> None:
        """Swap the active provider mid-session.

        Mirrors `action_switch_view`: in-memory only, doesn't persist. The
        tree and chat pane reset to the new provider's default scope and
        no selected item (both are provider-specific).

        If no matching provider was built (e.g. the plugin failed to load),
        we toast and stay put rather than crashing."""
        providers = self.tui_ctx.providers or {}
        if name not in providers:
            self.notify(f"No provider named '{name}' is configured.", severity="warning")
            return
        config = self.tui_ctx.config
        entry = config.providers.get(name) if config else None
        if entry is None:
            self.notify(f"Provider '{name}' is not in config.toml.", severity="warning")
            return
        self.tui_ctx.provider = providers[name]
        self.tui_ctx.provider_key = name
        scope_name = entry.active_scope
        sf = entry.scopes.get(scope_name) or entry.scopes.get("default")
        if sf is None:
            # No scopes at all on this provider — use a wide-open one so the
            # UI at least renders. The user can add a scope from settings.
            from docket.config.models import ScopeFilter

            sf = ScopeFilter(assignee="")
            scope_name = "default"
        self.tui_ctx.scope_key = scope_name
        self.tui_ctx.scope = sf.to_core()
        self._selected_item_id = None
        # The agent holds tool closures bound to the old provider + provider_key.
        # Rebuild so `search_items` and `get_item` target the new backend. MCP
        # fleet is per-project (= per-provider), so rebind first.
        self._rebind_mcp_for_active_project()
        if self.tui_ctx.llm is not None:
            self._agent = build_agent(
                llm=self.tui_ctx.llm,
                conn=self.tui_ctx.conn,
                provider=self.tui_ctx.provider,
                store=self._proposals,
                active_item=lambda: self._selected_item_id,
                read_only=self.tui_ctx.read_only,
                provider_key=self.tui_ctx.provider_key,
                project_id=project_id_for(self.tui_ctx.provider_key),
                mcp_manager=self.tui_ctx.mcp_manager,
            )
        # The detail and chat panes were rendered for an item from the previous
        # provider. Wipe them so the user doesn't chat against a ticket that no
        # longer exists in the active cache slice.
        with contextlib.suppress(Exception):
            self.query_one(ItemDetail).show(None, [])
        with contextlib.suppress(Exception):
            self.query_one(ChatPane).bind_item(None)
        with contextlib.suppress(Exception):
            bar = self.query_one(StatusBar)
            bar.provider_name = entry.display_name
            bar.scope_label = scope_name
            bar.active_view = scope_name
            bar.project_name = self._resolve_project_name()
        with contextlib.suppress(Exception):
            self.query_one(ItemTree).stale_threshold_days = self._resolved_stale_threshold()
            self.query_one(ItemDetail).stale_threshold_days = self._resolved_stale_threshold()
        self._reload_tree()
        self.notify(
            f"Switched to provider '{entry.display_name}'.",
            severity="information",
        )

    def _active_provider_entry(self) -> ProviderEntry | None:
        """Resolve the ProviderEntry behind the currently-active provider.

        Returns None when the TUI was mounted without a full `config` (pilot
        tests), which lets the callers short-circuit safely."""
        config = self.tui_ctx.config
        if config is None:
            return None
        key = self.tui_ctx.provider_key
        return config.providers.get(key) if key else None

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

    def action_review_pending(self) -> None:
        if len(self._proposals) == 0:
            self.notify("No pending proposals.", severity="information")
            return
        self._open_next_pending()

    def _open_next_pending(self) -> None:
        from docket.core.mutation import Proposal

        count = len(self._proposals)
        if count == 0:
            return
        if count >= 2:
            # Batch review: one modal covers the whole queue so the user can
            # apply-all / apply-selected / reject-all in a single pass.
            self._open_batch_review()
            return

        pending = self._proposals.peek_next()
        if pending is None:
            return

        def on_decision(edited: Proposal | None) -> None:
            # peek_next did not remove; we drain here.
            popped = self._proposals.pop(pending.proposal.id)
            self._refresh_pending_count()
            if popped is None:
                return
            if edited is None:
                self.notify("Rejected.", severity="warning")
                return
            # The modal returns the (possibly edited) proposal — use that
            # when confirming so description-patch edits flow through.
            try:
                result = mutation_service.confirm(
                    self.tui_ctx.conn,
                    self.tui_ctx.provider,
                    edited,
                    provider_key=self.tui_ctx.provider_key,
                )
            except Exception as e:
                self.notify(
                    f"{humanize_error(e, action='Apply')} {retry_hint('d', 'review')}",
                    severity="error",
                )
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

    def _open_batch_review(self) -> None:
        """Open the batch modal with a snapshot of every pending proposal.

        Snapshotting up front means new proposals that land while the modal
        is open stay queued for the next review pass — we don't want the
        list shifting under the user mid-review."""
        pendings = self._proposals.list()
        if not pendings:
            return

        def on_batch_decision(decision: BatchDecision | None) -> None:
            if decision is None:
                # Cancel: queue unchanged, user can come back later.
                return
            # Drop rejected ids first — they never touch the provider.
            rejected = sum(1 for pid in decision.reject if self._proposals.pop(pid) is not None)
            applied = 0
            failed = 0
            for pid in decision.apply:
                popped = self._proposals.pop(pid)
                if popped is None:
                    continue
                try:
                    mutation_service.confirm(
                        self.tui_ctx.conn,
                        self.tui_ctx.provider,
                        popped.proposal,
                        provider_key=self.tui_ctx.provider_key,
                    )
                    applied += 1
                except Exception as e:
                    log.exception("batch apply failed for %s", pid)
                    self.notify(
                        f"{humanize_error(e, action=f'Apply {pid}')}",
                        severity="error",
                    )
                    failed += 1
            self._refresh_pending_count()
            if applied or rejected or failed:
                self._reload_tree()
                parts = [f"applied {applied}", f"rejected {rejected}"]
                if failed:
                    parts.append(f"failed {failed}")
                self.notify("Batch · " + ", ".join(parts) + ".")
            # If more proposals trickled in while we were reviewing, chain.
            if len(self._proposals) > 0:
                self._open_next_pending()

        self.push_screen(BatchDiffModal(pendings), on_batch_decision)


__all__ = ["DocketApp", "Pane", "TuiContext"]
