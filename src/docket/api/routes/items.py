"""Read + create endpoints for work items."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.deps import (
    get_active_provider_key,
    get_conn,
    get_proposals,
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
from docket.core.model import Item, ItemKind, ItemState
from docket.core.mutation import ItemCreate
from docket.core.services import mutation_service, visual_filter
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, item_repo, search_repo


def _provider_call_or_502[T](fn: Callable[[], T]) -> T:
    """Run `fn` and translate any provider error into an HTTP 502."""
    try:
        return fn()
    except Exception as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Provider lookup failed: {e}") from e


def get_item_or_fetch(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    item_id: str,
    provider_key: str,
) -> Item:
    """Return a cached Item, or fetch-and-cache from the provider on miss.

    Parents often live outside the sync scope (different Azure DevOps project,
    untracked work-item type, or a scope filter that excludes them), so the
    cache alone isn't enough to back parent-link navigation. On a cache miss
    we fall back to `provider.get_item`, upsert the result, and return it.
    Raises 404 if the provider can't produce the item either."""
    cached = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if cached is not None:
        return cached
    try:
        fresh = provider.get_item(item_id)
    except Exception as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown item '{item_id}'") from e
    if provider_key:
        fresh.provider_key = provider_key
    item_repo.upsert_item(conn, fresh)
    return fresh


router = APIRouter(prefix="/items", tags=["items"])


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


@router.get("/search", response_model=list[ItemDTO])
def search_items(
    q: str = Query("", description="Title substring to find duplicate candidates for."),
    limit: int = Query(5, ge=1, le=50),
    kind: ItemKind | None = Query(None),
    conn: sqlite3.Connection = Depends(get_conn),
    provider_key: str = Depends(get_active_provider_key),
) -> list[ItemDTO]:
    """Return cached items whose indexed content loosely matches `q`.

    Backs the create-item duplicate-candidate panel: OR-semantics FTS5 search
    scoped to the active provider. Empty `q` returns `[]`."""
    stripped = q.strip()
    if not stripped:
        return []
    ids = search_repo.search(conn, stripped, provider_key=provider_key, operator="OR")
    out: list[ItemDTO] = []
    for iid in ids:
        if len(out) >= limit:
            break
        item = item_repo.get_item(conn, iid, provider_key=provider_key)
        if item is None:
            continue
        if kind is not None and item.kind is not kind:
            continue
        out.append(ItemDTO.from_core(item))
    return out


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
        fresh = _provider_call_or_502(lambda: provider.get_comments(item_id))
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
    linked = _provider_call_or_502(lambda: provider.get_linked(item_id))
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
        fresh = _provider_call_or_502(lambda: provider.get_item(item_id))
        if provider_key:
            fresh.provider_key = provider_key
        item_repo.upsert_item(conn, fresh)
        return ItemDTO.from_core(fresh)
    return ItemDTO.from_core(get_item_or_fetch(conn, provider, item_id, provider_key))


@router.post(
    "",
    status_code=status.HTTP_201_CREATED,
    response_model=ProposalDTO,
    dependencies=[Depends(require_not_read_only)],
)
def create_item(
    payload: CreateItemRequest,
    store: ProposalStore = Depends(get_proposals),
) -> ProposalDTO:
    """Stage a work-item creation as a proposal.

    Mirrors the propose/confirm/reject flow used for edits: the caller
    receives a `ProposalDTO` (with `id` and a human-readable `diff`) and
    must follow up with `POST /items/proposals/{proposal_id}/confirm` to
    actually create the item, or `/reject` to discard it. Nothing hits the
    provider until confirm."""
    proposal = ItemCreate(item_kind=payload.kind, fields=payload.to_create_fields())
    store.add(proposal, source="api")
    return ProposalDTO.from_core(proposal)


@router.post(
    "/proposals/{proposal_id}/confirm",
    response_model=MutationConfirmedDTO,
    dependencies=[Depends(require_not_read_only)],
)
def confirm_item_create(
    proposal_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> MutationConfirmedDTO:
    pending = store.pop(proposal_id)
    if pending is None or not isinstance(pending.proposal, ItemCreate):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")
    try:
        result = mutation_service.confirm(
            conn, provider, pending.proposal, provider_key=provider_key
        )
    except Exception as e:
        # Re-stage so the caller can retry or inspect — matches the per-item
        # mutations confirm endpoint.
        store.add(pending.proposal, source=pending.source)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Create failed: {e}") from e
    return MutationConfirmedDTO(
        proposal_id=result.proposal_id,
        dry_run=result.dry_run,
        item=ItemDTO.from_core(result.item) if result.item else None,
    )


@router.post(
    "/proposals/{proposal_id}/reject",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def reject_item_create(
    proposal_id: str,
    store: ProposalStore = Depends(get_proposals),
) -> None:
    popped = store.pop(proposal_id)
    if popped is None or not isinstance(popped.proposal, ItemCreate):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")


__all__ = ["get_item_or_fetch", "router"]
