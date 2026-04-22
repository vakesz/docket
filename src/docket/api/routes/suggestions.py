"""Suggest-next-action endpoint wrapping `suggestion_service`.

Two-step to match the TUI:
1. `POST /items/{id}/suggestion` — one-shot LLM call returning a structured
   recommendation (intent, optional description patch, open questions).
2. `POST /items/{id}/suggestion/stage` — takes the (possibly-edited) suggestion
   and stages the underlying proposals through the normal proposal pipeline,
   returning their ProposalDTOs. The client confirms each via the existing
   `/items/{id}/mutations/{pid}/confirm` endpoint."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, status

from docket.agent.llm_client import LlmClient
from docket.api.auth import require_bearer
from docket.api.deps import (
    get_conn,
    get_proposals,
    require_llm,
    require_not_read_only,
)
from docket.api.schemas import ProposalDTO, SuggestionDTO, SuggestionStageRequest
from docket.core.services import mutation_service, suggestion_service
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.suggestion_service import Suggestion, SuggestionError
from docket.storage.repos import item_repo

router = APIRouter(
    prefix="/items/{item_id}/suggestion",
    tags=["suggestions"],
    dependencies=[Depends(require_bearer)],
)


@router.post("", response_model=SuggestionDTO)
def get_suggestion(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    llm: LlmClient = Depends(require_llm),
) -> SuggestionDTO:
    item = item_repo.get_item(conn, item_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown item '{item_id}'")
    try:
        suggestion = suggestion_service.suggest_next_action(conn, llm, item)
    except SuggestionError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, f"Suggestion failed: {e}") from e
    return SuggestionDTO(
        item_id=suggestion.item_id,
        intent=suggestion.intent,
        description_patch_md=suggestion.description_patch_md,
        open_questions=list(suggestion.open_questions),
    )


@router.post(
    "/stage",
    response_model=list[ProposalDTO],
    dependencies=[Depends(require_not_read_only)],
)
def stage_suggestion(
    item_id: str,
    payload: SuggestionStageRequest,
    conn: sqlite3.Connection = Depends(get_conn),
    store: ProposalStore = Depends(get_proposals),
) -> list[ProposalDTO]:
    suggestion = Suggestion(
        item_id=item_id,
        intent=payload.intent,
        description_patch_md=payload.description_patch_md,
    )
    try:
        staged = suggestion_service.stage_suggestion(conn, suggestion)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    out: list[ProposalDTO] = []
    store.add(staged.state_change, source="api")
    out.append(ProposalDTO.from_core(staged.state_change))
    if staged.description_patch is not None:
        store.add(staged.description_patch, source="api")
        out.append(ProposalDTO.from_core(staged.description_patch))
    # mutation_service.propose_transition/description both only read the cache;
    # no commit needed here. Kept explicit for clarity.
    _ = mutation_service  # silence unused-import check when running mypy strict
    return out


__all__ = ["router"]
