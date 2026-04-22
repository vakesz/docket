"""Connection / sync status snapshot for the frontend status footer + top bar."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from docket.api.auth import require_bearer
from docket.api.deps import get_proposals, get_runtime
from docket.api.runtime import RuntimeState
from docket.api.schemas import StatusDTO
from docket.core.services.proposal_store import ProposalStore

router = APIRouter(tags=["status"], dependencies=[Depends(require_bearer)])


@router.get("/status", response_model=StatusDTO)
def status(
    request: Request,
    runtime: RuntimeState = Depends(get_runtime),
    store: ProposalStore = Depends(get_proposals),
) -> StatusDTO:
    entry = runtime.config.providers[runtime.provider_key]
    return StatusDTO(
        provider_key=runtime.provider_key,
        provider_display=entry.display_name,
        scope_key=runtime.scope_key,
        read_only=bool(getattr(request.app.state, "read_only", False)),
        chat_enabled=getattr(request.app.state, "agent", None) is not None,
        last_sync_at=runtime.last_sync_at,
        offline=runtime.offline,
        pending_proposals=len(store),
    )


__all__ = ["router"]
