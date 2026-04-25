"""Background workers that tick from `DocketApp.on_mount`.

Two long-running periodic jobs:

- `tick_background_sync` — incremental WIQL pulls so the backlog stays
  fresh while the user works. Spawns a thread worker per tick so a slow
  provider call never blocks the UI; `exclusive=True` keeps the queue from
  stacking up.
- `tick_external_watch` — polls the active item for provider-side changes
  and injects a system message into the chat when something moves.

Free helpers, not a mixin: `DocketApp.on_mount` calls into these via
`functools.partial(tick_background_sync, self)`. Keeping them at module
level (rather than dragging in a mixin with TYPE_CHECKING shims) means we
don't need to declare the host's attributes twice for mypy."""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from docket.cli.tui._status_helpers import update_status_bar
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.core.services import external_update_service, sync_service
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, item_repo

if TYPE_CHECKING:
    from docket.cli.tui.app import DocketApp

log = logging.getLogger(__name__)


def schedule_next_sync(app: DocketApp, interval: float) -> None:
    """Publish the next-sync timestamp to the status bar. Called at
    startup (once `on_mount` resolves the interval) and after each tick
    so the countdown stays roughly accurate without its own repaint."""
    target = datetime.now(UTC) + timedelta(seconds=interval)
    update_status_bar(app, next_sync_at=target)


def tick_background_sync(app: DocketApp) -> None:
    """Kick off an incremental sync in the background.

    Provider calls block on the network, so we spawn a thread worker —
    the UI stays responsive while the sync runs. `exclusive=True` means
    a slow sync never stacks up behind itself.

    We snapshot the provider on the event-loop thread and close the
    worker over it; a mid-sync provider switch must not swap the target
    out from under an in-flight refresh. Sync pulls every item for the
    provider — views are applied at render time, not sync time."""
    interval = app._resolved_sync_interval()
    if interval <= 0:
        return  # Disabled mid-session — nothing to do.
    # Push the next target *now* so the countdown keeps moving even if
    # the worker is still chewing on the last one.
    schedule_next_sync(app, interval)
    provider = app.tui_ctx.provider
    provider_key = app.tui_ctx.provider_key
    app.run_worker(
        lambda: _background_sync_once(app, provider, provider_key),
        group="background-sync",
        exclusive=True,
        thread=True,
    )


def _background_sync_once(
    app: DocketApp,
    provider: WorkItemProvider,
    provider_key: str,
) -> None:
    try:
        summary = sync_service.refresh(
            app.tui_ctx.conn,
            provider,
            provider_key=provider_key,
        )
    except Exception:
        # Background sync is best-effort; a provider hiccup shouldn't
        # interrupt the session. Flip the offline flag so the user has
        # some signal that their list may be stale.
        log.exception("background sync failed for provider %s", provider_key)
        app.call_from_thread(set_offline, app, True)
        return

    def apply() -> None:
        set_offline(app, False)
        mark_sync_now(app)
        if summary.upserted or summary.archived:
            app._reload_tree()
            app.notify(
                f"Auto-sync · {summary.upserted} updated, {summary.archived} archived",
                severity="information",
                timeout=3,
            )

    app.call_from_thread(apply)


def tick_external_watch(app: DocketApp) -> None:
    """Runs on the Textual event loop every N seconds. Spawns a worker per
    tick so the provider call doesn't block the UI. No-op when no item is
    selected."""
    item_id = app._selected_item_id
    if item_id is None:
        return
    provider = app.tui_ctx.provider
    provider_key = app.tui_ctx.provider_key
    app.run_worker(
        lambda: _external_watch_once(app, item_id, provider, provider_key),
        group=f"external-watch-{item_id}",
        exclusive=True,
        thread=True,
    )


def _external_watch_once(
    app: DocketApp, item_id: str, provider: WorkItemProvider, provider_key: str
) -> None:
    try:
        result = external_update_service.check_and_inject(
            app.tui_ctx.conn,
            provider,
            item_id,
            provider_key=provider_key,
        )
    except Exception:
        # External updates are a nice-to-have; a provider hiccup shouldn't
        # break the session. We log and move on.
        log.exception("external-update poll failed for %s", item_id)
        return
    if not result.changed:
        return

    def apply() -> None:
        # Guard: the user may have switched items or providers between
        # the worker starting and this callback firing; only repaint if
        # both the item and its owning provider still match.
        if app._selected_item_id != item_id or app.tui_ctx.provider_key != provider_key:
            return
        fresh_item = item_repo.get_item(app.tui_ctx.conn, item_id, provider_key=provider_key)
        fresh_comments = comment_repo.list_comments(
            app.tui_ctx.conn, item_id, provider_key=provider_key
        )
        app.query_one(ItemDetail).show(fresh_item, fresh_comments)
        chat = app.query_one(ChatPane)
        chat.note(
            f"external update · {result.diff.splitlines()[0] if result.diff else 'metadata changed'}",
            cls="msg-system",
        )
        app.notify(
            f"{item_id} updated externally",
            severity="information",
        )

    app.call_from_thread(apply)


def mark_sync_now(app: DocketApp) -> None:
    with contextlib.suppress(Exception):
        app.query_one(StatusBar).set_last_sync_now()


def set_offline(app: DocketApp, offline: bool) -> None:
    update_status_bar(app, offline=offline)


__all__ = [
    "mark_sync_now",
    "schedule_next_sync",
    "set_offline",
    "tick_background_sync",
    "tick_external_watch",
]
