"""Single gate for all provider mutations.

Flow:
    proposal = mutation_service.propose_transition(ctx, "42", TransitionIntent.CLOSE_DONE)
    render_diff(proposal)                             # show to user
    result = mutation_service.confirm(ctx, proposal)  # executes via provider

Dry-run short-circuits before any provider call. Successful writes refresh the
local cache so subsequent reads match the remote state.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from docket.core.model import Comment, CreateFields, Item, ItemKind, MemoryEntry, TransitionIntent
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
from docket.providers.base import WorkItemProvider
from docket.storage import transaction
from docket.storage.item_keys import item_storage_key
from docket.storage.repos import comment_repo, item_repo, memory_repo
from docket.telemetry.logging import get_logger

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


def propose_transition(
    conn: sqlite3.Connection,
    item_id: str,
    intent: TransitionIntent,
    *,
    provider_key: str = "",
) -> StateChange:
    item = _require_cached(conn, item_id, provider_key=provider_key)
    return StateChange(item=item, intent=intent)


def propose_description_patch(
    conn: sqlite3.Connection,
    item_id: str,
    new_md: str,
    *,
    provider_key: str = "",
) -> DescriptionPatch:
    item = _require_cached(conn, item_id, provider_key=provider_key)
    return DescriptionPatch(item=item, new_md=new_md)


def propose_attachment(
    conn: sqlite3.Connection,
    item_id: str,
    filename: str,
    content: bytes,
    content_type: str = "text/markdown; charset=utf-8",
    *,
    provider_key: str = "",
) -> AttachmentUpload:
    item = _require_cached(conn, item_id, provider_key=provider_key)
    return AttachmentUpload(
        item=item, filename=filename, content=content, content_type=content_type
    )


def propose_create(kind: ItemKind, fields: CreateFields) -> ItemCreate:
    return ItemCreate(item_kind=kind, fields=fields)


def propose_comment(
    conn: sqlite3.Connection,
    item_id: str,
    body_md: str,
    *,
    provider_key: str = "",
) -> CommentAdd:
    item = _require_cached(conn, item_id, provider_key=provider_key)
    return CommentAdd(item=item, body_md=body_md)


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
    from docket.core.services import memory_service

    memory_service._require_project(conn, project_id)  # KeyError on unknown project
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
    from docket.core.services import memory_service

    memory_service._require_project(conn, project_id)
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
            latency_ms=_elapsed_ms(started),
            exc_info=True,
        )
        raise
    _log.info(
        "proposal_confirm",
        proposal_type=proposal_type,
        provider=provider_key or None,
        outcome="ok",
        latency_ms=_elapsed_ms(started),
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
    if isinstance(proposal, StateChange):
        updated = provider.transition(proposal.item.id, proposal.intent)
        _refresh_cache(conn, updated, provider_key)
        return MutationResult(proposal_id=proposal.id, dry_run=False, item=updated)

    if isinstance(proposal, DescriptionPatch):
        updated = provider.patch_description(proposal.item.id, proposal.new_md)
        _refresh_cache(conn, updated, provider_key)
        return MutationResult(proposal_id=proposal.id, dry_run=False, item=updated)

    if isinstance(proposal, AttachmentUpload):
        url = provider.upload_attachment(
            proposal.item.id, proposal.filename, proposal.content, proposal.content_type
        )
        with transaction(conn):
            conn.execute(
                "INSERT INTO attachments (id, item_id, conversation_id, filename, remote_url, uploaded_at) "
                "VALUES (?, ?, NULL, ?, ?, ?)",
                (
                    str(uuid.uuid4()),
                    item_storage_key(proposal.item.provider_key or provider_key, proposal.item.id),
                    proposal.filename,
                    url,
                    datetime.now(UTC).isoformat(),
                ),
            )
        return MutationResult(proposal_id=proposal.id, dry_run=False, attachment_url=url)

    if isinstance(proposal, ItemCreate):
        created = provider.create_item(proposal.item_kind, proposal.fields)
        _refresh_cache(conn, created, provider_key)
        return MutationResult(proposal_id=proposal.id, dry_run=False, item=created)

    if isinstance(proposal, CommentAdd):
        comment = provider.add_comment(proposal.item.id, proposal.body_md)
        # Refresh both the cached comments list and the item row (so its
        # `updated_at` reflects the provider-side change). We swallow refresh
        # failures so a slow comments fetch doesn't fail the write that already
        # succeeded — the next read will reconcile via `?refresh=true`.
        try:
            fresh = provider.get_comments(proposal.item.id)
        except Exception:
            fresh = None
        active_key = proposal.item.provider_key or provider_key
        if fresh is not None:
            with transaction(conn):
                comment_repo.replace_comments_for_item(
                    conn, proposal.item.id, fresh, provider_key=active_key
                )
        try:
            refreshed_item = provider.get_item(proposal.item.id)
        except Exception:
            refreshed_item = None
        if refreshed_item is not None:
            _refresh_cache(conn, refreshed_item, provider_key)
        return MutationResult(proposal_id=proposal.id, dry_run=False, comment=comment)

    if isinstance(proposal, MemoryWrite):
        from docket.core.services import memory_service

        entry = memory_service.apply_memory_write(
            conn,
            project_id=proposal.project_id,
            title=proposal.title,
            body_md=proposal.body_md,
            tags=list(proposal.tags),
            source=proposal.source,
            memory_id=proposal.memory_id,
        )
        return MutationResult(proposal_id=proposal.id, dry_run=False, memory=entry)

    if isinstance(proposal, MemoryDelete):
        from docket.core.services import memory_service

        ok = memory_service.apply_memory_delete(conn, proposal.memory_id)
        return MutationResult(
            proposal_id=proposal.id,
            dry_run=False,
            memory_deleted_id=proposal.memory_id if ok else None,
        )

    raise TypeError(f"unknown proposal type: {type(proposal)!r}")


def _require_cached(conn: sqlite3.Connection, item_id: str, *, provider_key: str = "") -> Item:
    item = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if item is None:
        raise KeyError(
            f"no cached item with id={item_id}; run `docket sync` or open it first to load context"
        )
    return item


def _refresh_cache(conn: sqlite3.Connection, item: Item, provider_key: str) -> None:
    if provider_key:
        item.provider_key = provider_key
    with transaction(conn):
        item_repo.upsert_item(conn, item)


def _elapsed_ms(started_ns: int) -> int:
    return (time.monotonic_ns() - started_ns) // 1_000_000
