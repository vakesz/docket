"""Propose-then-confirm endpoints for state/description/attachment mutations.

The agent exercises this flow too (via the in-process mutating tools), so these
routes are a thin mirror that lets a headless API caller drive the same pipeline.
Proposals land in the shared `ProposalStore`; `/confirm` hands them to
`mutation_service.confirm`."""

from __future__ import annotations

import base64
import binascii
import sqlite3
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.deps import (
    get_active_provider_key,
    get_conn,
    get_proposals,
    get_provider,
    require_not_read_only,
)
from docket.api.schemas import (
    CommentDTO,
    ItemDTO,
    MutationConfirmedDTO,
    ProposalDTO,
    ProposeAttachmentRequest,
    ProposeCommentRequest,
    ProposeDescriptionRequest,
    ProposeTransitionRequest,
)
from docket.core.mutation import (
    AttachmentUpload,
    CommentAdd,
    DescriptionPatch,
    Proposal,
    StateChange,
)
from docket.core.services import mutation_service
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider

router = APIRouter(
    prefix="/items/{item_id:path}/mutations",
    tags=["mutations"],
    dependencies=[Depends(require_not_read_only)],
)


def _stage(store: ProposalStore, build: Callable[[], Proposal]) -> ProposalDTO:
    """Shared plumbing for every `*/propose` endpoint: run the service call,
    translate "item not found" into a 404, and hand the result off to the
    proposal store before serializing."""
    try:
        proposal = build()
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    store.add(proposal, source="api")
    return ProposalDTO.from_core(proposal)


@router.post("/transition/propose", response_model=ProposalDTO)
def propose_transition(
    item_id: str,
    payload: ProposeTransitionRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> ProposalDTO:
    return _stage(
        store,
        lambda: StateChange(
            item=mutation_service.require_cached_item(conn, item_id, provider_key=provider_key),
            intent=payload.intent,
        ),
    )


@router.post("/description/propose", response_model=ProposalDTO)
def propose_description(
    item_id: str,
    payload: ProposeDescriptionRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> ProposalDTO:
    return _stage(
        store,
        lambda: DescriptionPatch(
            item=mutation_service.require_cached_item(conn, item_id, provider_key=provider_key),
            new_md=payload.new_description_md,
        ),
    )


@router.post("/attachment/propose", response_model=ProposalDTO)
def propose_attachment(
    item_id: str,
    payload: ProposeAttachmentRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> ProposalDTO:
    try:
        content = base64.b64decode(payload.content_base64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Invalid base64 content: {e}") from e
    return _stage(
        store,
        lambda: AttachmentUpload(
            item=mutation_service.require_cached_item(conn, item_id, provider_key=provider_key),
            filename=payload.filename,
            content=content,
            content_type=payload.content_type,
        ),
    )


@router.post("/comment/propose", response_model=ProposalDTO)
def propose_comment(
    item_id: str,
    payload: ProposeCommentRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> ProposalDTO:
    if not payload.body_md.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Comment body cannot be empty")
    return _stage(
        store,
        lambda: CommentAdd(
            item=mutation_service.require_cached_item(conn, item_id, provider_key=provider_key),
            body_md=payload.body_md,
        ),
    )


@router.get("/{proposal_id}", response_model=ProposalDTO)
def get_proposal(
    item_id: str,
    proposal_id: str,
    store: ProposalStore = Depends(get_proposals),
) -> ProposalDTO:
    pending = store.get(proposal_id)
    if pending is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")
    return ProposalDTO.from_core(pending.proposal)


@router.post("/{proposal_id}/confirm", response_model=MutationConfirmedDTO)
def confirm_proposal(
    item_id: str,
    proposal_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    store: ProposalStore = Depends(get_proposals),
    provider_key: str = Depends(get_active_provider_key),
) -> MutationConfirmedDTO:
    pending = store.pop(proposal_id)
    if pending is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")
    try:
        result = mutation_service.confirm(
            conn, provider, pending.proposal, provider_key=provider_key
        )
    except Exception as e:
        # Re-stage so caller can retry or inspect.
        store.add(pending.proposal, source=pending.source)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Apply failed: {e}") from e
    return MutationConfirmedDTO(
        proposal_id=result.proposal_id,
        dry_run=result.dry_run,
        item=ItemDTO.from_core(result.item) if result.item else None,
        attachment_url=result.attachment_url,
        comment=CommentDTO.from_core(result.comment) if result.comment else None,
    )


@router.post("/{proposal_id}/reject", status_code=status.HTTP_204_NO_CONTENT)
def reject_proposal(
    item_id: str,
    proposal_id: str,
    store: ProposalStore = Depends(get_proposals),
) -> None:
    popped = store.pop(proposal_id)
    if popped is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")


__all__ = ["router"]
