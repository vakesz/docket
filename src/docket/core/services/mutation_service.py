"""Single gate for all provider mutations.

Flow:
    item = mutation_service.require_cached_item(conn, "42")
    proposal = StateChange(item=item, intent=TransitionIntent.CLOSE_DONE)
    render_diff(proposal)                                       # show to user
    result = mutation_service.confirm(conn, provider, proposal)  # executes via provider

Dry-run short-circuits before any provider call. Successful writes refresh the
local cache so subsequent reads match the remote state.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from docket.core.model import Comment, Item, MemoryEntry
from docket.core.mutation import (
    AttachmentUpload,
    CommentAdd,
    DescriptionPatch,
    ItemCreate,
    MemoryDelete,
    MemoryWrite,
    Proposal,
    StateChange,
)
from docket.providers.base import ProviderError, WorkItemProvider
from docket.storage import transaction
from docket.storage.item_keys import item_storage_key
from docket.storage.repos import comment_repo, item_repo, memory_repo, project_repo
from docket.telemetry.logging import elapsed_ms, get_logger

_log = get_logger(__name__)


@dataclass(frozen=True)
class MutationResult:
    proposal_id: str
    dry_run: bool
    item: Item | None = None  # None for attachment_upload (use attachment_url)
    attachment_url: str | None = None
    comment: Comment | None = None  # set for comment_add
    memory: MemoryEntry | None = None  # set for memory_write
    memory_deleted_id: str | None = None  # set for memory_delete


def require_cached_item(
    conn: sqlite3.Connection,
    item_id: str,
    *,
    provider_key: str = "",
    provider: WorkItemProvider | None = None,
) -> Item:
    """Fetch the cached `Item` for `item_id`, or raise `KeyError`.

    Item proposals (`StateChange`, `DescriptionPatch`, `AttachmentUpload`,
    `CommentAdd`) all need a fully-hydrated `Item` so the diff renderer can
    show before/after state. Callers go: `item = require_cached_item(...)`,
    then build the proposal dataclass directly.

    Parents and cross-scope items may legitimately miss the cache. When a
    `provider` is given, fall back to a live fetch and cache the result so
    subsequent calls hit the fast path."""
    item = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if item is not None:
        return item
    if provider is not None:
        try:
            fetched = provider.get_item(item_id)
        except Exception as e:
            raise KeyError(
                f"no cached item with id={item_id} and provider lookup failed: {e}"
            ) from e
        if provider_key:
            fetched.provider_key = provider_key
        item_repo.upsert_item(conn, fetched)
        return fetched
    raise KeyError(
        f"no cached item with id={item_id}; run `docket sync` or open it first to load context"
    )


def propose_memory_write(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    title: str,
    body_md: str,
    tags: list[str] | None = None,
    source: str = "agent",
    memory_id: str | None = None,
) -> MemoryWrite:
    """Build a `MemoryWrite` proposal.

    Validates: project exists; on edit, target memory entry exists and
    actually belongs to `project_id` (rejects cross-project edits)."""
    project_repo.require_project(conn, project_id)
    previous_title = ""
    previous_body_md = ""
    if memory_id:
        existing = memory_repo.get(conn, memory_id)
        if existing is None:
            raise ValueError(f"unknown memory entry '{memory_id}'")
        if existing.project_id != project_id:
            raise ValueError(
                f"memory entry '{memory_id}' belongs to project "
                f"'{existing.project_id}', not '{project_id}'"
            )
        previous_title = existing.title
        previous_body_md = existing.body_md
    return MemoryWrite(
        project_id=project_id,
        title=title,
        body_md=body_md,
        tags=tuple(tags or ()),
        source=source,
        memory_id=memory_id,
        previous_title=previous_title,
        previous_body_md=previous_body_md,
    )


def propose_memory_delete(
    conn: sqlite3.Connection,
    *,
    project_id: str,
    memory_id: str,
) -> MemoryDelete:
    project_repo.require_project(conn, project_id)
    existing = memory_repo.get(conn, memory_id)
    if existing is None:
        raise ValueError(f"unknown memory entry '{memory_id}'")
    if existing.project_id != project_id:
        raise ValueError(
            f"memory entry '{memory_id}' belongs to project "
            f"'{existing.project_id}', not '{project_id}'"
        )
    return MemoryDelete(
        project_id=project_id,
        memory_id=memory_id,
        title=existing.title,
    )


def confirm(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    proposal: Proposal,
    *,
    dry_run: bool = False,
    provider_key: str = "",
) -> MutationResult:
    """Execute a proposal.

    `provider_key` is stamped onto the refreshed cache row so the shared
    items cache stays filterable by provider. Pass it whenever the caller
    knows which provider is active; otherwise the existing row's key is
    preserved by the UPSERT (new items created without it land unscoped and
    get stamped on the next sync)."""
    proposal_type = type(proposal).__name__
    if dry_run:
        _log.info(
            "proposal_confirm",
            proposal_type=proposal_type,
            provider=provider_key or None,
            outcome="dry_run",
            latency_ms=0,
        )
        return MutationResult(proposal_id=proposal.id, dry_run=True)

    started = time.monotonic_ns()
    try:
        result = _execute(conn, provider, proposal, provider_key=provider_key)
    except Exception as exc:
        _log.warning(
            "proposal_confirm",
            proposal_type=proposal_type,
            provider=provider_key or None,
            outcome="error",
            error_type=type(exc).__name__,
            latency_ms=elapsed_ms(started),
            exc_info=True,
        )
        raise
    _log.info(
        "proposal_confirm",
        proposal_type=proposal_type,
        provider=provider_key or None,
        outcome="ok",
        latency_ms=elapsed_ms(started),
    )
    return result


def _execute(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    proposal: Proposal,
    *,
    provider_key: str,
) -> MutationResult:
    """Dispatch a proposal to the right provider call. The wrapper in
    `confirm` measures latency and emits the proposal-outcome log line."""
    match proposal:
        case StateChange():
            updated = provider.transition(proposal.item.id, proposal.intent)
            _refresh_cache(conn, updated, provider_key)
            return MutationResult(proposal_id=proposal.id, dry_run=False, item=updated)

        case DescriptionPatch():
            updated = provider.patch_description(proposal.item.id, proposal.new_md)
            _refresh_cache(conn, updated, provider_key)
            return MutationResult(proposal_id=proposal.id, dry_run=False, item=updated)

        case AttachmentUpload():
            url = provider.upload_attachment(
                proposal.item.id, proposal.filename, proposal.content, proposal.content_type
            )
            with transaction(conn):
                conn.execute(
                    "INSERT INTO attachments (id, item_id, conversation_id, filename, remote_url, uploaded_at) "
                    "VALUES (?, ?, NULL, ?, ?, ?)",
                    (
                        str(uuid.uuid4()),
                        item_storage_key(
                            proposal.item.provider_key or provider_key, proposal.item.id
                        ),
                        proposal.filename,
                        url,
                        datetime.now(UTC).isoformat(),
                    ),
                )
            return MutationResult(proposal_id=proposal.id, dry_run=False, attachment_url=url)

        case ItemCreate():
            created = provider.create_item(proposal.item_kind, proposal.fields)
            _refresh_cache(conn, created, provider_key)
            return MutationResult(proposal_id=proposal.id, dry_run=False, item=created)

        case CommentAdd():
            comment = provider.add_comment(proposal.item.id, proposal.body_md)
            # Refresh both the cached comments list and the item row (so its
            # `updated_at` reflects the provider-side change). Swallow refresh
            # failures — the write already succeeded; next read reconciles via `?refresh=true`.
            try:
                fresh = provider.get_comments(proposal.item.id)
            except (ProviderError, TimeoutError, sqlite3.Error):
                _log.warning("comment_refresh_failed", item_id=proposal.item.id, exc_info=True)
                fresh = None
            active_key = proposal.item.provider_key or provider_key
            if fresh is not None:
                with transaction(conn):
                    comment_repo.replace_comments_for_item(
                        conn, proposal.item.id, fresh, provider_key=active_key
                    )
            try:
                refreshed_item = provider.get_item(proposal.item.id)
            except (ProviderError, TimeoutError, sqlite3.Error):
                _log.warning("item_refresh_failed", item_id=proposal.item.id, exc_info=True)
                refreshed_item = None
            if refreshed_item is not None:
                _refresh_cache(conn, refreshed_item, active_key)
            return MutationResult(proposal_id=proposal.id, dry_run=False, comment=comment)

        case MemoryWrite():
            entry = memory_repo.upsert_for_proposal(
                conn,
                project_id=proposal.project_id,
                title=proposal.title,
                body_md=proposal.body_md,
                tags=list(proposal.tags),
                source=proposal.source,
                memory_id=proposal.memory_id,
            )
            return MutationResult(proposal_id=proposal.id, dry_run=False, memory=entry)

        case MemoryDelete():
            ok = memory_repo.delete(conn, proposal.memory_id)
            return MutationResult(
                proposal_id=proposal.id,
                dry_run=False,
                memory_deleted_id=proposal.memory_id if ok else None,
            )

        case _:
            raise TypeError(f"unknown proposal type: {type(proposal)!r}")


def _refresh_cache(conn: sqlite3.Connection, item: Item, provider_key: str) -> None:
    if provider_key:
        item.provider_key = provider_key
    with transaction(conn):
        item_repo.upsert_item(conn, item)
