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
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from docket.core.model import CreateFields, Item, ItemKind, TransitionIntent
from docket.core.mutation import (
    AttachmentUpload,
    DescriptionPatch,
    ItemCreate,
    Proposal,
    StateChange,
)
from docket.providers.base import WorkItemProvider
from docket.storage import transaction
from docket.storage.item_keys import item_storage_key
from docket.storage.repos import item_repo


@dataclass(frozen=True)
class MutationResult:
    proposal_id: str
    dry_run: bool
    item: Item | None = None  # None for attachment_upload (use attachment_url)
    attachment_url: str | None = None


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
    if dry_run:
        return MutationResult(proposal_id=proposal.id, dry_run=True)

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
