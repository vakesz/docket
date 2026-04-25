from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from docket.core.model import ScopeFilters, SyncSummary
from docket.providers.base import WorkItemProvider
from docket.storage import transaction
from docket.storage.repos import item_repo, sync_repo


def refresh(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    *,
    provider_key: str = "",
) -> SyncSummary:
    """Incremental refresh — pull every item changed since the last watermark
    for this provider, upsert into the cache, and bump the watermark to the
    newest item seen.

    We always pass an explicit empty `ScopeFilters` to the provider so the cache
    holds every ticket the provider exposes; the TUI/CLI/HTTP layers narrow
    the view at query time. This matters because items assigned to the user
    can link to items assigned to someone else — both need to be cached so
    chat and detail panes can follow parent/child edges.

    `provider_key` stamps every upserted row so the shared cache can be
    filtered by provider later; callers that actually run multiple providers
    in one DB should always pass it.

    Per plan §13: offline is fail-fast. Provider errors propagate out so the
    caller (CLI / TUI / API) can surface them immediately."""
    watermark = sync_repo.get_watermark(conn, provider_key)
    items = list(provider.list_changes_since(watermark, ScopeFilters(assignee="")))

    archived_ids: list[str] = []
    for item in items:
        if provider_key:
            item.provider_key = provider_key
        if item.provider_raw.get("archived"):
            archived_ids.append(item.id)
    all_timestamps = [item.updated_at for item in items if item.updated_at]
    max_seen = max(all_timestamps, default=watermark)

    with transaction(conn):
        upserted = item_repo.upsert_items(conn, items)
        archived = item_repo.mark_archived(conn, archived_ids, provider_key=provider_key)
        new_watermark = max_seen or datetime.now(UTC)
        sync_repo.set_watermark(conn, provider_key, new_watermark)

    return SyncSummary(upserted=upserted, archived=archived, watermark=max_seen)


def full_refresh(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    *,
    provider_key: str = "",
) -> SyncSummary:
    """Reset the watermark and resync everything the provider exposes. Used on
    first launch and on `docket sync --full`."""
    with transaction(conn):
        sync_repo.record_full_sync(conn, provider_key)
        conn.execute(
            "UPDATE sync_state SET watermark_iso = NULL WHERE provider_key = ?",
            (provider_key,),
        )
    return refresh(conn, provider, provider_key=provider_key)
