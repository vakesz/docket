"""Read + create endpoints for work items."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.auth import require_bearer
from docket.api.deps import (
    get_active_provider_key,
    get_conn,
    get_provider,
    get_runtime_optional,
    require_not_read_only,
)
from docket.api.runtime import RuntimeState
from docket.api.schemas import (
    CommentDTO,
    CreateItemRequest,
    ItemDTO,
    MutationConfirmedDTO,
    ProposalDTO,
)
from docket.core.model import ItemKind, ItemState
from docket.core.services import mutation_service, visual_filter
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, item_repo

router = APIRouter(
    prefix="/items",
    tags=["items"],
    dependencies=[Depends(require_bearer)],
)


@router.get("", response_model=list[ItemDTO])
def list_items(
    conn: sqlite3.Connection = Depends(get_conn),
    kind: ItemKind | None = Query(None, description="Filter by item kind."),
    state: list[ItemState] | None = Query(
        None,
        description="Filter by item state. Repeat to union (e.g. ?state=active&state=blocked).",
    ),
    tag: str | None = Query(None, description="Filter to items that carry this tag/label."),
    include_archived: bool = Query(False, alias="archived"),
    parent_id: str | None = Query(None),
    apply_view: bool = Query(
        True,
        description="Apply the active saved view as a post-cache filter. "
        "Set false to see every cached item regardless of view.",
    ),
    provider: WorkItemProvider = Depends(get_provider),
    provider_key: str = Depends(get_active_provider_key),
    runtime: RuntimeState | None = Depends(get_runtime_optional),
) -> list[ItemDTO]:
    resolved = (
        visual_filter.resolve(runtime.scope, provider)
        if apply_view and runtime is not None
        else visual_filter.ResolvedFilter()
    )
    items = item_repo.list_items(
        conn,
        kind=kind,
        states=state,
        tag=tag,
        parent_id=parent_id,
        include_archived=include_archived,
        provider_key=provider_key,
        assignee=resolved.assignee,
    )
    items = visual_filter.apply_to_items(items, resolved)
    return [ItemDTO.from_core(i) for i in items]


# Sub-path routes must come before the bare `/{item_id:path}` catch-all,
# otherwise `:path` greedy-matches and swallows `/comments`, `/linked` into
# the item id.
@router.get("/{item_id:path}/comments", response_model=list[CommentDTO])
def get_comments(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    refresh: bool = Query(False, description="Fetch fresh from provider."),
    provider_key: str = Depends(get_active_provider_key),
) -> list[CommentDTO]:
    if refresh:
        try:
            fresh = provider.get_comments(item_id)
        except Exception as e:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
        comment_repo.replace_comments_for_item(conn, item_id, fresh, provider_key=provider_key)
        return [CommentDTO.from_core(c) for c in fresh]
    return [
        CommentDTO.from_core(c)
        for c in comment_repo.list_comments(conn, item_id, provider_key=provider_key)
    ]


@router.get("/{item_id:path}/linked", response_model=list[ItemDTO])
def get_linked(
    item_id: str,
    provider: WorkItemProvider = Depends(get_provider),
) -> list[ItemDTO]:
    try:
        linked = provider.get_linked(item_id)
    except Exception as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
    return [ItemDTO.from_core(i) for i in linked]


@router.get("/{item_id:path}", response_model=ItemDTO)
def get_item(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    refresh: bool = Query(False, description="Fetch from provider instead of cache."),
    provider_key: str = Depends(get_active_provider_key),
) -> ItemDTO:
    if refresh:
        try:
            fresh = provider.get_item(item_id)
        except Exception as e:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
        if provider_key:
            fresh.provider_key = provider_key
        item_repo.upsert_item(conn, fresh)
        return ItemDTO.from_core(fresh)
    cached = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if cached is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown item '{item_id}'")
    return ItemDTO.from_core(cached)


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def create_item(
    payload: CreateItemRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    dry_run: bool = Query(False, description="Return the proposal without creating."),
    provider_key: str = Depends(get_active_provider_key),
) -> ProposalDTO | MutationConfirmedDTO:
    """Create a work item through the mutation pipeline.

    With `dry_run=true`, returns a `ProposalDTO` the caller can preview. Without,
    executes the create and returns the stored result (still via
    `mutation_service.confirm`, so any provider-side validation runs)."""
    proposal = mutation_service.propose_create(payload.kind, payload.to_create_fields())
    if dry_run:
        return ProposalDTO.from_core(proposal)
    try:
        result = mutation_service.confirm(conn, provider, proposal, provider_key=provider_key)
    except Exception as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Create failed: {e}") from e
    item_dto = ItemDTO.from_core(result.item) if result.item else None
    return MutationConfirmedDTO(
        proposal_id=result.proposal_id,
        dry_run=result.dry_run,
        item=item_dto,
    )


__all__ = ["router"]
