"""Manual sync endpoint — wraps `sync_service.refresh` / `full_refresh`.

The TUI has a background tick and a `Sync now` action; the HTTP frontend
relies on this endpoint for the equivalent manual refresh. Updates
`runtime.last_sync_at` and flips `offline` on provider errors."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.auth import require_bearer
from docket.api.deps import get_conn, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import SyncSummaryDTO
from docket.core.services import sync_service

router = APIRouter(
    prefix="/sync",
    tags=["sync"],
    dependencies=[Depends(require_bearer), Depends(require_not_read_only)],
)


@router.post("", response_model=SyncSummaryDTO)
def manual_sync(
    conn: sqlite3.Connection = Depends(get_conn),
    runtime: RuntimeState = Depends(get_runtime),
    full: bool = Query(False, description="Reset watermark before syncing."),
) -> SyncSummaryDTO:
    try:
        if full:
            summary = sync_service.full_refresh(
                conn, runtime.provider, runtime.scope_key, runtime.scope
            )
        else:
            summary = sync_service.refresh(conn, runtime.provider, runtime.scope_key, runtime.scope)
    except Exception as e:
        runtime.offline = True
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Sync failed: {e}") from e
    runtime.offline = False
    runtime.last_sync_at = datetime.now(UTC)
    return SyncSummaryDTO(
        upserted=summary.upserted,
        archived=summary.archived,
        watermark=summary.watermark,
        offline=False,
    )


__all__ = ["router"]
