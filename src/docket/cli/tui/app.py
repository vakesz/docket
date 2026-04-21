from __future__ import annotations

import logging
import traceback
import webbrowser
from dataclasses import dataclass

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.widgets import Footer, Header, Input

log = logging.getLogger(__name__)

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
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.core.model import ItemKind, ScopeFilters
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
from docket.storage.repos import comment_repo, conversation_repo, item_repo


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


class ItvApp(App[None]):
    """Three-pane terminal UI for browsing and triaging work items."""

    CSS = """
    #main { height: 1fr; }
    #left  { width: 35%; border: round $primary; }
    #mid   { width: 40%; border: round $secondary; }
    #right { width: 25%; border: round $accent; }
    #filter { dock: top; height: 1; }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit", priority=True),
        Binding("r", "refresh", "Refresh"),
        Binding("slash", "focus_filter", "Filter"),
        Binding("question_mark", "show_help", "Help"),
        Binding("t", "new_thread", "New thread"),
        Binding("d", "review_pending", "Review pending"),
        Binding("o", "open_in_browser", "Open in browser"),
        Binding("s", "suggest_next", "Suggest next action"),
    ]

    def __init__(self, tui_ctx: TuiContext) -> None:
        super().__init__()
        self.tui_ctx = tui_ctx
        self.title = "Docket"
        self._selected_item_id: str | None = None
        self._proposals = ProposalStore()
        self._agent: AgentLoop | None = None
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
            with Vertical(id="left"):
                yield Input(placeholder="filter (/) — title contains…", id="filter")
                yield ItemTree(id="tree")
            yield ItemDetail(id="mid")
            yield ChatPane(id="right")
        yield Footer()

    def on_mount(self) -> None:
        self._reload_tree()
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

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "filter":
            return
        query = (event.value or "").strip().lower()
        items = item_repo.list_items(self.tui_ctx.conn)  # type: ignore[arg-type]
        if query:
            items = [i for i in items if query in i.title.lower()]
        self.query_one(ItemTree).load_items(items)

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

    def _run_turn(self, item_id: str, text: str):
        chat = self.query_one(ChatPane)

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
            return
        self._reload_tree()
        self.notify(
            f"Synced {summary.upserted}, archived {summary.archived}",
            severity="information",
        )

    def action_focus_filter(self) -> None:
        self.query_one("#filter", Input).focus()

    def action_show_help(self) -> None:
        self.notify(
            "j/k navigate • enter open • o browser • / filter • r refresh • t new thread • q quit",
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
