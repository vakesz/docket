"""Tree/filter/detail selection plumbing for `DocketApp`.

The backlog pane is the app's main navigation surface. This module owns
the handlers that react to selection, filter input, and the small
cross-pane keystrokes (Esc from chat, Up/Down from the filter) — plus the
few actions that operate on the focused item (open in browser, toggle
pin, quick-open).

Free helpers, not a mixin: `DocketApp` keeps thin `on_*` / `action_*`
delegates because Textual's binding/message dispatcher looks them up by
name on the App, but the mechanics live here as `app: DocketApp`
callables. See `pane_layout.py` for the companion focus-cycling helpers."""

from __future__ import annotations

import logging
import webbrowser
from typing import TYPE_CHECKING

from textual import events
from textual.widgets import Input

from docket.cli.tui.pane_layout import defocus_chat_prompt
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemSelected, ItemTree
from docket.cli.tui.widgets.quick_open import QuickOpenModal, QuickOpenResult
from docket.core.model import ItemState
from docket.core.services import visual_filter
from docket.providers import registry
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
    from docket.cli.tui.app import DocketApp

log = logging.getLogger(__name__)


def reload_tree(app: DocketApp) -> None:
    apply_filter(app, "")


def resolved_grouping(app: DocketApp) -> GroupingStrategy:
    """Grouping strategy declared by the active provider's spec.

    Falls back to `"by_kind"` when the config isn't available (pilot tests)
    or the provider's type id isn't registered."""
    entry = app._active_provider_entry()
    if entry is None:
        return "by_kind"
    spec = registry.spec(entry.type)
    if spec is None:
        return "by_kind"
    return spec.grouping


def list_item_states(app: DocketApp) -> tuple[ItemState, ...] | None:
    """States to pass to `item_repo.list_items`. `None` means "no filter"
    — for the "show done" toggle — and matches calling `list_items` with no
    `states=` argument."""
    if not app.tui_ctx.hide_done:
        return None
    return (
        ItemState.NEW,
        ItemState.ACTIVE,
        ItemState.BLOCKED,
        ItemState.NEEDS_INFO,
    )


def apply_filter(app: DocketApp, raw: str) -> None:
    """Re-render the tree for the given filter query.

    Empty query = full list. Non-empty delegates to the FTS5-backed
    search_repo so title + description + comments all match, returning
    items in bm25 rank order. The active view filter (assignee, area,
    iteration, team) is layered on top of the search hits so scope and
    free-text narrow together."""
    query = raw.strip()
    tree = app.query_one(ItemTree)
    pinned = watchlist_repo.list_pinned_items(
        app.tui_ctx.conn, provider_key=app.tui_ctx.provider_key
    )
    resolved = app._active_view_filter()
    grouping = resolved_grouping(app)
    states = list_item_states(app)
    if not query:
        items = item_repo.list_items(
            app.tui_ctx.conn,
            provider_key=app.tui_ctx.provider_key,
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
        app.tui_ctx.conn,
        query,
        provider_key=app.tui_ctx.provider_key,
        assignee=resolved.assignee,
    )
    if not ids:
        tree.load_items([], pinned=pinned, grouping=grouping)
        return
    by_id = {
        i.id: i
        for i in item_repo.list_items_by_ids(
            app.tui_ctx.conn,
            ids,
            provider_key=app.tui_ctx.provider_key,
            states=states,
        )
    }
    ordered = [by_id[iid] for iid in ids if iid in by_id]
    tree.load_items(
        visual_filter.apply_to_items(ordered, resolved),
        pinned=pinned,
        grouping=grouping,
    )


def on_item_selected(app: DocketApp, message: ItemSelected) -> None:
    item = item_repo.get_item(
        app.tui_ctx.conn, message.item_id, provider_key=app.tui_ctx.provider_key
    )
    comments = comment_repo.list_comments(
        app.tui_ctx.conn, message.item_id, provider_key=app.tui_ctx.provider_key
    )
    app.query_one(ItemDetail).show(item, comments)
    chat = app.query_one(ChatPane)
    chat.bind_item(item)
    app._selected_item_id = item.id if item else None
    app._reset_cost_display()
    if item is not None:
        active = conversation_repo.get_active_for_item(
            app.tui_ctx.conn,
            item.id,
            provider_key=app.tui_ctx.provider_key,
        )
        if active is None:
            chat.show_history([])
        else:
            history = message_repo.list_for_conversation(app.tui_ctx.conn, active.id)
            chat.show_history(history)
        # Re-render any pending `ask_user` card for this item so the
        # question survives a tab-away/tab-back. The store is in-memory,
        # so this only triggers when the agent staged the question in
        # this same TUI session.
        pending = app._hydrate_pending_question(item.id)
        if pending is not None:
            chat.show_question(pending)
        else:
            chat.clear_question()
        # Fetch fresh details (attachments, up-to-date description, comments)
        # from the provider in the background — the WIQL sync batch can't carry
        # relations, so attachments only show up after this hydrates.
        app.run_worker(
            lambda item_id=item.id: _hydrate_detail(app, item_id),
            group=f"hydrate-{item.id}",
            exclusive=True,
            thread=True,
        )


def _hydrate_detail(app: DocketApp, item_id: str) -> None:
    try:
        fresh = app.tui_ctx.provider.get_item(item_id)
        fresh_comments = app.tui_ctx.provider.get_comments(item_id)
    except Exception:
        log.exception("detail hydrate failed for %s", item_id)
        return
    if app.tui_ctx.provider_key:
        fresh.provider_key = app.tui_ctx.provider_key
    item_repo.upsert_item(app.tui_ctx.conn, fresh)
    comment_repo.replace_comments_for_item(
        app.tui_ctx.conn,
        item_id,
        fresh_comments,
        provider_key=app.tui_ctx.provider_key,
    )

    # Only repaint if the user hasn't moved on to another item.
    def paint() -> None:
        if app._selected_item_id == item_id:
            app.query_one(ItemDetail).show(fresh, fresh_comments)

    app.call_from_thread(paint)


def on_input_changed(app: DocketApp, event: Input.Changed) -> None:
    if event.input.id != "filter":
        return
    apply_filter(app, event.value or "")


def on_input_submitted(app: DocketApp, event: Input.Submitted) -> None:
    # Enter in the filter is redundant with the live-filter path, but we
    # still honor it so nothing feels broken and pilot tests that drive
    # `action_submit` continue to work.
    if event.input.id != "filter":
        return
    apply_filter(app, event.value or "")


def on_key(app: DocketApp, event: events.Key) -> None:
    filter_input = app.query_one("#filter", Input)
    tree = app.query_one(ItemTree)
    if event.key == "escape" and defocus_chat_prompt(app):
        event.stop()
        event.prevent_default()
        return
    if event.key == "down" and app.focused is filter_input:
        _move_from_filter_to_tree(app)
        event.stop()
        event.prevent_default()
        return
    if event.key == "up" and app.focused is tree and _move_from_tree_to_filter(app):
        event.stop()
        event.prevent_default()


def _move_from_filter_to_tree(app: DocketApp) -> None:
    tree = app.query_one(ItemTree)
    tree.focus()
    if tree.cursor_node is not None and tree.cursor_line >= 0:
        tree.action_cursor_down()
        return
    first_item = tree.first_visible_item_node()
    if first_item is not None:
        tree.move_cursor(first_item, animate=False)


def _move_from_tree_to_filter(app: DocketApp) -> bool:
    tree = app.query_one(ItemTree)
    first_item = tree.first_visible_item_node()
    if first_item is None:
        return False
    if tree.cursor_node is not first_item and tree.cursor_line > first_item.line:
        return False
    app.query_one("#filter", Input).focus()
    return True


def focus_filter(app: DocketApp) -> None:
    app.query_one("#filter", Input).focus()


def quick_open(app: DocketApp) -> None:
    """Prompt for a ticket id; on submit, route through the normal
    item-selection path so on_item_selected runs unchanged."""

    def on_result(result: QuickOpenResult | None) -> None:
        if result is None or result.item_id is None:
            return
        item = item_repo.get_item(
            app.tui_ctx.conn, result.item_id, provider_key=app.tui_ctx.provider_key
        )
        if item is None:
            app.notify(f"No item '{result.item_id}' in cache.", severity="warning")
            return
        # Reuse the tree's message path so on_item_selected runs unchanged.
        app.post_message(ItemSelected(item.id))

    app.push_screen(
        QuickOpenModal(conn=app.tui_ctx.conn, provider_key=app.tui_ctx.provider_key),
        on_result,
    )


def open_in_browser(app: DocketApp) -> None:
    if app._selected_item_id is None:
        app.notify("Select an item first.", severity="warning")
        return
    item = item_repo.get_item(
        app.tui_ctx.conn,
        app._selected_item_id,
        provider_key=app.tui_ctx.provider_key,
    )
    if item is None or not item.url:
        app.notify("This item has no URL on file.", severity="warning")
        return
    webbrowser.open(item.url)
    app.notify(f"Opened {item.id} in browser")


def toggle_pin(app: DocketApp) -> None:
    """Pin or unpin the focused item. Pins survive scope/view switches —
    they come from the `watchlist` table, joined on `items.id` at reload
    time, so archived rows drop out without any bookkeeping here."""
    if app._selected_item_id is None:
        app.notify("Select an item first.", severity="warning")
        return
    item_id = app._selected_item_id
    if watchlist_repo.is_pinned(app.tui_ctx.conn, item_id, provider_key=app.tui_ctx.provider_key):
        watchlist_repo.unpin(app.tui_ctx.conn, item_id, provider_key=app.tui_ctx.provider_key)
        app.notify(f"Unpinned {item_id}.", severity="information")
    else:
        watchlist_repo.pin(app.tui_ctx.conn, item_id, provider_key=app.tui_ctx.provider_key)
        app.notify(f"Pinned {item_id}.", severity="information")
    reload_tree(app)


__all__ = [
    "apply_filter",
    "focus_filter",
    "list_item_states",
    "on_input_changed",
    "on_input_submitted",
    "on_item_selected",
    "on_key",
    "open_in_browser",
    "quick_open",
    "reload_tree",
    "resolved_grouping",
    "toggle_pin",
]
