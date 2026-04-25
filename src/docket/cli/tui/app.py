from __future__ import annotations

import contextlib
import logging
from collections.abc import Callable
from typing import ClassVar

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.command import Provider
from textual.containers import Horizontal
from textual.widgets import Input

from docket.agent.factory import build_agent
from docket.agent.loop import AgentLoop
from docket.agent.tools import ToolRegistry
from docket.agent.types import ChatMessage, StreamDelta
from docket.cli.tui._status_helpers import update_status_bar
from docket.cli.tui.background_tasks import BackgroundTasksMixin
from docket.cli.tui.config_actions import ConfigMixin
from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.errors import retry_hint
from docket.cli.tui.item_selection import ItemSelectionMixin
from docket.cli.tui.pane_layout import PaneLayoutMixin
from docket.cli.tui.panes import FullscreenToggle, Pane
from docket.cli.tui.review_flow import ReviewFlowMixin
from docket.cli.tui.suggestion_flow import SuggestionFlowMixin
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.view_resolver import (
    active_provider_entry,
    active_view_filter,
    resolve_project_name,
    resolve_stale_threshold,
    resolve_sync_interval,
)
from docket.cli.tui.widgets.chat_pane import (
    AnswerQuestionRequest,
    ChatPane,
    TurnFinished,
    UserTurnRequest,
)
from docket.cli.tui.widgets.help_modal import HelpModal
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.mcp_pane import MCPPane
from docket.cli.tui.widgets.memory_pane import MemoryPane
from docket.cli.tui.widgets.new_item_modal import NewItemModal
from docket.cli.tui.widgets.source_pane import SourcePane
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.config.models import ProviderEntry
from docket.core.model import (
    SyncSummary,
    TransitionIntent,
    project_id_for,
)
from docket.core.mutation import ItemCreate, Proposal, StateChange
from docket.core.question import Question, QuestionAnswer
from docket.core.services import (
    conversation_service,
    mutation_service,
    sync_service,
    visual_filter,
)
from docket.core.services.proposal_store import PendingProposal, ProposalStore
from docket.core.services.question_store import QuestionStore

log = logging.getLogger(__name__)


def _docket_commands_provider() -> type[Provider]:
    """Lazy loader for the Docket command-palette provider.

    Imported this way because `commands.py` imports `DocketApp` under
    `TYPE_CHECKING`, so a top-level import here would be circular."""
    from docket.cli.tui.commands import DocketCommands

    return DocketCommands


class DocketApp(
    BackgroundTasksMixin,
    PaneLayoutMixin,
    ItemSelectionMixin,
    ConfigMixin,
    ReviewFlowMixin,
    SuggestionFlowMixin,
    App[None],
):
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
        self._questions = QuestionStore()
        self._agent: AgentLoop | None = None
        self._pane_pct: dict[str, int] = dict(self._DEFAULT_PANE_PCT)
        self._rebuild_agent()

    def compose(self) -> ComposeResult:
        with Horizontal(id="main"):
            with Pane(id="left"):
                yield FullscreenToggle()
                yield Input(placeholder="Search backlog…  (: to open by id)", id="filter")
                yield ItemTree(
                    id="tree",
                    stale_threshold_days=self._resolved_stale_threshold(),
                    grouping=self._resolved_grouping(),
                )
            with Pane(id="mid"):
                yield FullscreenToggle()
                yield ItemDetail(
                    id="mid-detail",
                    stale_threshold_days=self._resolved_stale_threshold(),
                )
            with Pane(id="right"):
                yield FullscreenToggle()
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
        return active_view_filter(self.tui_ctx)

    def _resolved_stale_threshold(self) -> int | None:
        return resolve_stale_threshold(self.tui_ctx)

    def _resolved_sync_interval(self) -> float:
        return resolve_sync_interval(self.tui_ctx)

    def _init_status_bar(self) -> None:
        """Populate the static status-bar segments (provider name, scope key).

        Dynamic segments (last sync, offline, thinking, pending, cost,
        read-only) are updated elsewhere — here we just put the right initial
        values up so the bar doesn't render with em-dashes on first paint."""
        provider = self.tui_ctx.provider
        display = getattr(provider, "display_name", None) or type(provider).__name__
        update_status_bar(
            self,
            provider_name=str(display),
            scope_label=self.tui_ctx.scope_key,
            active_view=self.tui_ctx.scope_key,
            project_name=self._resolve_project_name(),
            read_only=self.tui_ctx.read_only,
            pending_count=len(self._proposals),
            tooltip=(
                "Session status: project, provider, active view, sync health, "
                "chat activity, pending proposals, cost, and read-only mode."
            ),
        )

    def _refresh_pending_count(self) -> None:
        """Push the current pending-proposal count into the status bar.

        Called after every mutation of `self._proposals` so the visible count
        matches reality without polling."""
        update_status_bar(self, pending_count=len(self._proposals))

    def _set_thinking(self, value: bool) -> None:
        """Toggle the in-pane "thinking…" indicator next to the chat prompt.

        Deliberately scoped to the chat pane — a duplicate segment in the
        status bar pulled the eye away from the transcript. Safe from worker
        threads because reactive assignments are atomic."""
        with contextlib.suppress(Exception):
            self.query_one(ChatPane).set_thinking(value)

    def _resolve_project_name(self) -> str:
        return resolve_project_name(self.tui_ctx)

    def _rebuild_agent(self) -> None:
        """Rebuild the agent, rebinding all tool closures to the current provider/project.

        Must be called after any provider switch or MCP config change so the
        tool registry targets the new backend. No-op when no LLM is configured."""
        if self.tui_ctx.llm is None:
            return
        # A provider/project switch invalidates any pending question — its
        # tool-call closure was captured by the previous agent and would now
        # publish into the wrong conversation key.
        self._questions.clear()
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
            question_store=self._questions,
        )

    def _require_project_context(self, feature: str) -> tuple[str, str] | None:
        """Return (project_id, project_name) for the active project, or toast and return None."""
        if self.tui_ctx.config is None:
            self.notify(f"{feature} is unavailable in this session.", severity="warning")
            return None
        project_id = project_id_for(self.tui_ctx.provider_key)
        return project_id, self._resolve_project_name() or project_id

    # ---- public accessors (pilot tests, diagnostics) -----------------------
    # These exist so tests don't have to reach through private attributes to
    # observe state. Keeping them as methods (not properties) mirrors the
    # existing `_resolved_*` pattern and makes the "public API for tests"
    # boundary visible in rg.

    def pending_proposal_count(self) -> int:
        """Number of proposals staged and awaiting user confirmation."""
        return len(self._proposals)

    def peek_next_proposal(self) -> PendingProposal | None:
        """Head of the proposal queue, or None when nothing is pending."""
        return self._proposals.peek_next()

    def stage_proposal(self, proposal: Proposal, *, source: str) -> None:
        """Stage a proposal as if the agent had produced it.

        Used by pilot tests to exercise the review flow without running a
        full LLM turn. Production code paths stage through `mutation_service`
        + agent tools; both funnel into the same `ProposalStore`."""
        self._proposals.add(proposal, source=source)
        self._refresh_pending_count()

    def active_agent_tools(self) -> ToolRegistry | None:
        """Tool registry for the running agent, or None when LLM is unconfigured."""
        return self._agent.tools if self._agent else None

    def effective_sync_interval(self) -> float:
        """Sync interval that actually drives the background timer."""
        return self._resolved_sync_interval()

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
            toggle.tooltip = (
                "Maximize this pane to fill the screen, or restore the three-pane layout. "
                "Ctrl+F does the same."
            )

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

    def on_answer_question_request(self, event: AnswerQuestionRequest) -> None:
        """`QuestionCard` posted answers — resume the agent loop."""
        if self._agent is None or self._selected_item_id is None:
            self.query_one(ChatPane).note("Chat is not configured.", cls="msg-system")
            return
        item_id = self._selected_item_id
        question_id = event.question_id
        answers = event.answers
        # The card disables its own controls on submit; we leave it visible so
        # the user sees what they answered while the agent's reply streams in.
        self.run_worker(
            lambda: self._run_answer(item_id, question_id, answers),
            group="chat",
            exclusive=True,
            thread=True,
        )

    def _run_turn(self, item_id: str, text: str) -> None:
        chat = self.query_one(ChatPane)
        if self._agent is None:
            self.call_from_thread(chat.note, "Agent is not available.", cls="msg-system")
            return

        def on_delta(delta: StreamDelta) -> None:
            self.call_from_thread(chat.append_delta, delta)

        def on_message(msg: ChatMessage) -> None:
            if msg.role == "assistant":
                # Content itself was already streamed via on_delta — don't
                # double-render. But an assistant message can carry both
                # preamble text AND tool_calls, so check tool_calls regardless
                # of whether content is present.
                if msg.tool_calls:
                    names = ", ".join(tc.name for tc in msg.tool_calls)
                    self.call_from_thread(chat.note, f"→ calling {names}")
                return
            if msg.role == "tool":
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
                question_store=self._questions,
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
        if result.pending_question is not None:
            self.call_from_thread(chat.show_question, result.pending_question)
        else:
            self.call_from_thread(chat.clear_question)
        # If the turn produced pending proposals, surface the first one.
        if len(self._proposals) > 0:
            self.call_from_thread(self._refresh_pending_count)
            self.call_from_thread(self._open_next_pending)

    def _run_answer(
        self,
        item_id: str,
        question_id: str,
        answers: tuple[QuestionAnswer, ...],
    ) -> None:
        """Worker that resumes a turn after the user answers an `ask_user`."""
        chat = self.query_one(ChatPane)
        if self._agent is None:
            self.call_from_thread(chat.note, "Agent is not available.", cls="msg-system")
            return

        def on_delta(delta: StreamDelta) -> None:
            self.call_from_thread(chat.append_delta, delta)

        def on_message(msg: ChatMessage) -> None:
            if msg.role == "assistant":
                if msg.tool_calls:
                    names = ", ".join(tc.name for tc in msg.tool_calls)
                    self.call_from_thread(chat.note, f"→ calling {names}")
                return
            if msg.role == "tool":
                preview = (msg.content or "")[:80].replace("\n", " ")
                self.call_from_thread(chat.note, f"← {msg.name}: {preview}")

        self.call_from_thread(chat.begin_assistant)
        self.call_from_thread(self._set_thinking, True)
        try:
            result = conversation_service.submit_question_answer(
                self.tui_ctx.conn,
                self._agent,
                item_id,
                question_id,
                answers,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=self.tui_ctx.compaction_threshold_tokens or None,
                provider_key=self.tui_ctx.provider_key,
                project_id=project_id_for(self.tui_ctx.provider_key),
                question_store=self._questions,
            )
        except Exception as e:
            log.exception("answer resume failed")
            friendly = humanize_error(e, action="Answer")
            self.call_from_thread(
                chat.note,
                f"{friendly} (see logs for the full traceback)",
                cls="msg-system",
            )
            self.call_from_thread(chat.clear_question)
            self.call_from_thread(self._set_thinking, False)
            return
        self.call_from_thread(chat.finish_turn, result.usage)
        self.call_from_thread(self._set_thinking, False)
        if result.pending_question is not None:
            self.call_from_thread(chat.show_question, result.pending_question)
        else:
            self.call_from_thread(chat.clear_question)
        if len(self._proposals) > 0:
            self.call_from_thread(self._refresh_pending_count)
            self.call_from_thread(self._open_next_pending)

    def _run_sync(
        self,
        sync_fn: Callable[..., SyncSummary],
        *,
        label: str,
        start_message: str,
        success_message: Callable[[SyncSummary], str],
    ) -> None:
        self.notify(start_message)
        try:
            summary = sync_fn(
                self.tui_ctx.conn,
                self.tui_ctx.provider,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception as e:  # provider failure → toast, not crash
            self.notify(
                f"{humanize_error(e, action=label)} {retry_hint('r', 'sync')}",
                severity="error",
            )
            self._set_offline(True)
            return
        self._set_offline(False)
        self._mark_sync_now()
        self._reload_tree()
        self.notify(success_message(summary), severity="information")

    def action_refresh(self) -> None:
        self._run_sync(
            sync_service.refresh,
            label="Sync",
            start_message=f"Syncing from {self.tui_ctx.provider_key or 'active provider'}…",
            success_message=lambda s: f"Synced {s.upserted}, archived {s.archived}",
        )

    def action_full_refresh(self) -> None:
        provider_label = self.tui_ctx.provider_key or "active provider"
        self._run_sync(
            sync_service.full_refresh,
            label="Full sync",
            start_message=f"Running full sync for {provider_label}…",
            success_message=(
                lambda s: f"Full sync complete: {s.upserted} cached, archived {s.archived}"
            ),
        )

    def action_show_help(self) -> None:
        self.push_screen(HelpModal())

    def action_new_thread(self) -> None:
        if self._selected_item_id is None:
            return
        # Drop any pending question for the old conversation; the new thread
        # starts clean and the agent has to re-ask if it still wants the info.
        self._abandon_pending_question(self._selected_item_id)
        conversation_service.new_thread(
            self.tui_ctx.conn,
            self._selected_item_id,
            provider_key=self.tui_ctx.provider_key,
        )
        chat = self.query_one(ChatPane)
        chat.show_history([])
        chat.clear_question()
        chat.set_status("")
        self._reset_cost_display()

    def _abandon_pending_question(self, item_id: str) -> None:
        """Drop any in-memory question staged for this item's active convo.

        Called on `new thread` and item switch so a stale closure can't fire
        an answer back into a conversation the user already moved past."""
        from docket.storage.repos import conversation_repo

        try:
            convo = conversation_repo.get_active_for_item(
                self.tui_ctx.conn,
                item_id,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception:
            return
        if convo is None:
            return
        project_id = project_id_for(self.tui_ctx.provider_key)
        self._questions.pop((self.tui_ctx.provider_key, project_id, convo.id))

    def _hydrate_pending_question(self, item_id: str) -> Question | None:
        """Look up a staged question for this item's active conversation, if any."""
        from docket.storage.repos import conversation_repo

        try:
            convo = conversation_repo.get_active_for_item(
                self.tui_ctx.conn,
                item_id,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception:
            return None
        if convo is None:
            return None
        project_id = project_id_for(self.tui_ctx.provider_key)
        return self._questions.peek((self.tui_ctx.provider_key, project_id, convo.id))

    def _reset_cost_display(self) -> None:
        """Zero the status-bar conversation-cost counter. Called on item
        switch and new-thread — each chat thread gets its own running total."""
        update_status_bar(self, cost_cents=0)

    def on_turn_finished(self, event: TurnFinished) -> None:
        """Roll the per-turn cost into the status bar's cumulative counter
        so the user sees $ spent on the active conversation at a glance."""
        with contextlib.suppress(Exception):
            bar = self.query_one(StatusBar)
            bar.cost_cents = bar.cost_cents + event.cost_cents

    def _blocked_read_only(self) -> bool:
        """Toast and return True if the user just tried to stage a mutation
        while the app is in read-only mode."""
        if self.tui_ctx.read_only:
            self.notify("Read-only mode — mutations disabled.", severity="warning")
            return True
        return False

    def action_new_item(self) -> None:
        """Open the new-ticket form. Submit stages an `ItemCreate` proposal
        that flows through the diff modal — same confirm gate as every other write."""
        if self._blocked_read_only():
            return
        self.run_worker(self._new_item_flow(), group="new-item", exclusive=False)

    async def _new_item_flow(self) -> None:
        result = await self.push_screen_wait(
            NewItemModal(
                self.tui_ctx.conn,
                default_kind=self.tui_ctx.default_new_item_kind,
                provider_key=self.tui_ctx.provider_key,
            )
        )
        if result is None:
            return
        self._proposals.add(ItemCreate(item_kind=result.kind, fields=result.fields), source="form")
        self._refresh_pending_count()
        self._open_next_pending()

    def action_open_memory(self) -> None:
        """Open the per-project memory editor for the active project."""
        ctx = self._require_project_context("Memory")
        if ctx is None:
            return
        project_id, project_name = ctx
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
        ctx = self._require_project_context("Sources")
        if ctx is None:
            return
        project_id, project_name = ctx
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
            if changed:
                self._rebuild_agent()

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
            item = mutation_service.require_cached_item(
                self.tui_ctx.conn,
                self._selected_item_id,
                provider_key=self.tui_ctx.provider_key,
            )
        except KeyError as e:
            self.notify(humanize_error(e, action="Stage transition"), severity="error")
            return
        proposal = StateChange(item=item, intent=intent)
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
        update_status_bar(self, scope_label=name, active_view=name)
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
        self._rebuild_agent()
        # The detail and chat panes were rendered for an item from the previous
        # provider. Wipe them so the user doesn't chat against a ticket that no
        # longer exists in the active cache slice.
        with contextlib.suppress(Exception):
            self.query_one(ItemDetail).show(None, [])
        with contextlib.suppress(Exception):
            self.query_one(ChatPane).bind_item(None)
        update_status_bar(
            self,
            provider_name=entry.display_name,
            scope_label=scope_name,
            active_view=scope_name,
            project_name=self._resolve_project_name(),
        )
        stale = self._resolved_stale_threshold()
        with contextlib.suppress(Exception):
            self.query_one(ItemTree).stale_threshold_days = stale
            self.query_one(ItemDetail).stale_threshold_days = stale
        self._reload_tree()
        self.notify(
            f"Switched to provider '{entry.display_name}'.",
            severity="information",
        )

    def _active_provider_entry(self) -> ProviderEntry | None:
        return active_provider_entry(self.tui_ctx)


__all__ = ["DocketApp", "Pane", "TuiContext"]
