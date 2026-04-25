"""Watchlist (pin/unpin) endpoints.

Pins survive scope and provider switches — the `watchlist` table is keyed by
item id, not scoped. Pin/unpin are idempotent; missing items 404 on read but
return 204 on write (matches the TUI's behaviour where you can pin an id
before it lands in the cache)."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.deps import get_active_provider_key, get_conn, require_not_read_only
from docket.api.schemas import ItemDTO, PinnedStatusDTO
from docket.storage.repos import item_repo, watchlist_repo

router = APIRouter(tags=["pins"])


@router.get("/items/{item_id:path}/pinned", response_model=PinnedStatusDTO)
def is_pinned(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider_key: str = Depends(get_active_provider_key),
) -> PinnedStatusDTO:
    if item_repo.get_item(conn, item_id, provider_key=provider_key) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown item '{item_id}'")
    return PinnedStatusDTO(
        item_id=item_id,
        pinned=watchlist_repo.is_pinned(conn, item_id, provider_key=provider_key),
    )


@router.post(
    "/items/{item_id:path}/pin",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def pin_item(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider_key: str = Depends(get_active_provider_key),
) -> None:
    watchlist_repo.pin(conn, item_id, provider_key=provider_key)


@router.delete(
    "/items/{item_id:path}/pin",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def unpin_item(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider_key: str = Depends(get_active_provider_key),
) -> None:
    watchlist_repo.unpin(conn, item_id, provider_key=provider_key)


@router.get("/pinned", response_model=list[ItemDTO])
def list_pinned(
    conn: sqlite3.Connection = Depends(get_conn),
    provider_key: str = Depends(get_active_provider_key),
) -> list[ItemDTO]:
    return [
        ItemDTO.from_core(i)
        for i in watchlist_repo.list_pinned_items(conn, provider_key=provider_key)
    ]


__all__ = ["router"]
