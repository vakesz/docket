"""Tree/filter/detail selection plumbing for `DocketApp`.

The backlog pane is the app's main navigation surface. This mixin owns the
handlers that react to selection, filter input, and the small cross-pane
keystrokes (Esc from chat, Up/Down from the filter) — plus the few actions
that operate on the focused item (open in browser, toggle pin, quick-open).

Leaving this logic in the mixin keeps `DocketApp` focused on composition
and cross-cutting state (agent, status bar, sync timers) while selection
and filter details live next to each other. See `pane_layout.py` for the
companion mixin that handles focus cycling and resize."""

from __future__ import annotations

import logging
import webbrowser
from typing import TYPE_CHECKING

from textual import events
from textual.widgets import Input

from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.view_resolver import (
    resolve_grouping,
    resolve_list_item_states,
)
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemSelected, ItemTree
from docket.cli.tui.widgets.quick_open import QuickOpenModal, QuickOpenResult
from docket.core.model import ItemState
from docket.core.services import visual_filter
from docket.providers.base import GroupingStrategy
from docket.storage.repos import (
    comment_repo,
    conversation_repo,
    item_repo,
    message_repo,
    search_repo,
    watchlist_repo,
)

if TYPE_CHECKING:
    from textual.app import App

    _AppBase = App[None]
else:
    _AppBase = object

log = logging.getLogger(__name__)


class ItemSelectionMixin(_AppBase):
    """Selection + filter handlers, tree-aware keystrokes, and per-item actions.

    Mypy sees the mixin as an `App[None]` so the many `query_one`/`notify`/
    `run_worker` calls type-check. Runtime base is `object` — `DocketApp`
    provides the real App. Host-provided state and sibling-mixin methods are
    declared under `TYPE_CHECKING` stubs below."""

    # Host-provided state (see DocketApp.__init__).
    tui_ctx: TuiContext
    _selected_item_id: str | None

    if TYPE_CHECKING:
        # Host-provided helpers (live in DocketApp).
        def _active_view_filter(self) -> visual_filter.ResolvedFilter: ...
        def _reset_cost_display(self) -> None: ...
        # Sibling mixin (PaneLayoutMixin).
        def _defocus_chat_prompt(self) -> bool: ...

    # ---- public accessors -------------------------------------------------

    def selected_item_id(self) -> str | None:
        """The currently focused item's id, or None when nothing is selected."""
        return self._selected_item_id

    # ---- reload / filter --------------------------------------------------

    def _reload_tree(self) -> None:
        self._apply_filter("")

    def _resolved_grouping(self) -> GroupingStrategy:
        return resolve_grouping(self.tui_ctx)

    def _list_item_states(self) -> tuple[ItemState, ...] | None:
        return resolve_list_item_states(self.tui_ctx)

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
            for i in item_repo.list_items_by_ids(
                self.tui_ctx.conn,
                ids,
                provider_key=self.tui_ctx.provider_key,
                states=states,
            )
        }
        ordered = [by_id[iid] for iid in ids if iid in by_id]
        tree.load_items(
            visual_filter.apply_to_items(ordered, resolved),
            pinned=pinned,
            grouping=grouping,
        )

    # ---- selection handlers -----------------------------------------------

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
                history = message_repo.list_for_conversation(self.tui_ctx.conn, active.id)
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

    # ---- filter input + cross-pane keystrokes -----------------------------

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

    # ---- focus / open actions --------------------------------------------

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
            self.notify(f"Unpinned {item_id}.", severity="information")
        else:
            watchlist_repo.pin(self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key)
            self.notify(f"Pinned {item_id}.", severity="information")
        self._reload_tree()


__all__ = ["ItemSelectionMixin"]
