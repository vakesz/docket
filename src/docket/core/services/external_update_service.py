"""External-update watcher.

The remote tracker is a shared system — someone else can retitle, restate, or
re-describe an item while a triage conversation is live. If we let the LLM
keep answering against a stale snapshot, its advice drifts silently from the
ticket it's supposed to be about.

Pattern: poll the provider for the currently selected item, compare against
the cached row, and when `updated_at` has advanced, (a) upsert the fresh row,
(b) inject one `system` message into the active conversation carrying a
terse diff so the next turn has grounding, and (c) let the TUI repaint.

This module is pure (no Textual imports) so it can be called from the TUI's
background worker and unit-tested with a FakeProvider.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime

from docket.agent.types import ChatMessage
from docket.core.model import Item
from docket.providers.base import WorkItemProvider
from docket.storage.db import transaction
from docket.storage.repos import conversation_repo, item_repo, message_repo

EXTERNAL_UPDATE_MARKER = "[external-update]"


@dataclass
class ExternalUpdateResult:
    item_id: str
    changed: bool
    diff: str  # empty when changed is False
    injected_message_id: str | None  # None when no active conversation
    refreshed_item: Item | None  # the fresh provider copy when changed


def check_and_inject(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    item_id: str,
    *,
    provider_key: str = "",
) -> ExternalUpdateResult:
    """Re-fetch `item_id` from the provider; if it moved since our cache, persist
    the new copy and drop a system message into the active conversation.

    Safe to call on a cadence — if the provider errors, raise; if nothing
    changed, return a no-op result so the caller can cheaply poll."""
    cached = item_repo.get_item(conn, item_id, provider_key=provider_key)
    fresh = provider.get_item(item_id)
    if provider_key:
        fresh.provider_key = provider_key

    if not _has_advanced(cached, fresh):
        return ExternalUpdateResult(
            item_id=item_id,
            changed=False,
            diff="",
            injected_message_id=None,
            refreshed_item=None,
        )

    diff = diff_items(cached, fresh)

    with transaction(conn):
        item_repo.upsert_item(conn, fresh)

    injected_id: str | None = None
    active = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if active is not None and diff:
        msg = ChatMessage(
            role="system",
            content=f"{EXTERNAL_UPDATE_MARKER}\n{diff}",
        )
        with transaction(conn):
            injected_id = message_repo.append(conn, active.id, msg)

    return ExternalUpdateResult(
        item_id=item_id,
        changed=True,
        diff=diff,
        injected_message_id=injected_id,
        refreshed_item=fresh,
    )


def diff_items(before: Item | None, after: Item) -> str:
    """Human-readable summary of the fields the model cares about. Intended for
    inline injection into a chat transcript, not for a structured UI diff."""
    lines: list[str] = []
    if before is None:
        lines.append(f"Item {after.id} appeared (was not in local cache).")
        lines.append(f"title: {after.title}")
        lines.append(f"state: {after.state.value}")
        return "\n".join(lines)

    if before.title != after.title:
        lines.append(f"title: {before.title!r} → {after.title!r}")
    if before.state != after.state:
        lines.append(f"state: {before.state.value} → {after.state.value}")
    if before.assignee != after.assignee:
        lines.append(f"assignee: {before.assignee} → {after.assignee}")
    if before.parent_id != after.parent_id:
        lines.append(f"parent: {before.parent_id} → {after.parent_id}")
    if sorted(before.tags) != sorted(after.tags):
        lines.append(f"tags: {sorted(before.tags)} → {sorted(after.tags)}")
    if before.description_md != after.description_md:
        lines.append(
            f"description changed ({len(before.description_md)} → "
            f"{len(after.description_md)} chars)"
        )
    if not lines:
        # updated_at moved but no tracked field changed — likely a comment,
        # a tag we don't normalize, or a workflow tick. Say so honestly.
        lines.append("metadata changed (updated_at advanced; no tracked field diff).")
    return "\n".join(f"- {line}" for line in lines)


def _has_advanced(cached: Item | None, fresh: Item) -> bool:
    if cached is None:
        return True
    if fresh.updated_at is None:
        return False
    if cached.updated_at is None:
        return True
    return _aware(fresh.updated_at) > _aware(cached.updated_at)


def _aware(dt: datetime) -> datetime:
    """Coerce naive timestamps to UTC so `>` is meaningful. SQLite round-trips
    can drop tzinfo depending on how the row was written."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


__all__ = [
    "EXTERNAL_UPDATE_MARKER",
    "ExternalUpdateResult",
    "check_and_inject",
    "diff_items",
]
