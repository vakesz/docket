"""Read + create endpoints for work items."""
from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.auth import require_bearer
from docket.api.deps import get_conn, get_provider
from docket.api.schemas import (
    CommentDTO,
    CreateItemRequest,
    ItemDTO,
    MutationConfirmedDTO,
    ProposalDTO,
)
from docket.core.model import ItemKind
from docket.core.services import mutation_service
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
    include_archived: bool = Query(False, alias="archived"),
    parent_id: str | None = Query(None),
) -> list[ItemDTO]:
    items = item_repo.list_items(
        conn, kind=kind, parent_id=parent_id, include_archived=include_archived
    )
    return [ItemDTO.from_core(i) for i in items]


@router.get("/{item_id}", response_model=ItemDTO)
def get_item(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    refresh: bool = Query(False, description="Fetch from provider instead of cache."),
) -> ItemDTO:
    if refresh:
        try:
            fresh = provider.get_item(item_id)
        except Exception as e:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
        item_repo.upsert_item(conn, fresh)
        return ItemDTO.from_core(fresh)
    cached = item_repo.get_item(conn, item_id)
    if cached is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown item '{item_id}'")
    return ItemDTO.from_core(cached)


@router.get("/{item_id}/comments", response_model=list[CommentDTO])
def get_comments(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    refresh: bool = Query(False, description="Fetch fresh from provider."),
) -> list[CommentDTO]:
    if refresh:
        try:
            fresh = provider.get_comments(item_id)
        except Exception as e:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
        comment_repo.replace_comments_for_item(conn, item_id, fresh)
        return [CommentDTO.from_core(c) for c in fresh]
    return [CommentDTO.from_core(c) for c in comment_repo.list_comments(conn, item_id)]


@router.get("/{item_id}/linked", response_model=list[ItemDTO])
def get_linked(
    item_id: str,
    provider: WorkItemProvider = Depends(get_provider),
) -> list[ItemDTO]:
    try:
        linked = provider.get_linked(item_id)
    except Exception as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e
    return [ItemDTO.from_core(i) for i in linked]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_item(
    payload: CreateItemRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    dry_run: bool = Query(False, description="Return the proposal without creating."),
) -> ProposalDTO | MutationConfirmedDTO:
    """Create a work item through the mutation pipeline.

    With `dry_run=true`, returns a `ProposalDTO` the caller can preview. Without,
    executes the create and returns the stored result (still via
    `mutation_service.confirm`, so any provider-side validation runs)."""
    proposal = mutation_service.propose_create(payload.kind, payload.to_create_fields())
    if dry_run:
        return ProposalDTO.from_core(proposal)
    try:
        result = mutation_service.confirm(conn, provider, proposal)
    except Exception as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Create failed: {e}") from e
    item_dto = ItemDTO.from_core(result.item) if result.item else None
    return MutationConfirmedDTO(
        proposal_id=result.proposal_id,
        dry_run=result.dry_run,
        item=item_dto,
    )


__all__ = ["router"]
