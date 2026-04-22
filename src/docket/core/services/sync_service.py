from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from docket.core.model import ScopeFilters, SyncSummary
from docket.providers.base import WorkItemProvider
from docket.storage import transaction
from docket.storage.item_keys import scope_storage_key
from docket.storage.repos import item_repo, sync_repo


def refresh(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    scope_key: str,
    filters: ScopeFilters,
    *,
    provider_key: str = "",
) -> SyncSummary:
    """Incremental refresh — pull items changed since the last watermark for this scope,
    upsert into the cache, and bump the watermark to the newest item seen.

    `provider_key` stamps every upserted row so the shared cache can be
    filtered by provider later; callers that actually run multiple providers
    in one DB should always pass it.

    Per plan §13: offline is fail-fast. Provider errors propagate out so the caller
    (CLI / TUI / API) can surface them immediately."""
    storage_scope_key = scope_storage_key(provider_key, scope_key)
    watermark = sync_repo.get_watermark(conn, storage_scope_key)
    items = list(provider.list_changes_since(watermark, filters))

    max_seen: datetime | None = watermark
    archived_ids: list[str] = []
    for item in items:
        if provider_key:
            item.provider_key = provider_key
        if item.provider_raw.get("archived"):
            archived_ids.append(item.id)
        if item.updated_at and (max_seen is None or item.updated_at > max_seen):
            max_seen = item.updated_at

    with transaction(conn):
        upserted = item_repo.upsert_items(conn, items)
        archived = item_repo.mark_archived(conn, archived_ids, provider_key=provider_key or None)
        new_watermark = max_seen or datetime.now(UTC)
        sync_repo.set_watermark(conn, storage_scope_key, new_watermark)

    return SyncSummary(upserted=upserted, archived=archived, watermark=max_seen)


def full_refresh(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    scope_key: str,
    filters: ScopeFilters,
    *,
    provider_key: str = "",
) -> SyncSummary:
    """Reset the watermark and resync everything in scope. Used on first launch
    and on `docket sync --full`."""
    with transaction(conn):
        storage_scope_key = scope_storage_key(provider_key, scope_key)
        sync_repo.record_full_sync(conn, storage_scope_key)
        conn.execute(
            "UPDATE sync_state SET watermark_iso = NULL WHERE scope_key = ?",
            (storage_scope_key,),
        )
    return refresh(conn, provider, scope_key, filters, provider_key=provider_key)
