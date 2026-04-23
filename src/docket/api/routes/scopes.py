"""Scope listing and active-view switching.

Views are visual filters — switching the active view doesn't change the
project, the MCP fleet, or the agent's tool registry. The frontend is
expected to re-query the item list after a successful switch so the new
filter is applied at render time."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.auth import require_bearer
from docket.api.deps import get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import ScopeDTO, ScopeSwitchRequest

router = APIRouter(
    prefix="/scopes",
    tags=["scopes"],
    dependencies=[Depends(require_bearer)],
)


def _entry_scopes(runtime: RuntimeState) -> list[ScopeDTO]:
    entry = runtime.config.providers[runtime.provider_key]
    return [
        ScopeDTO(
            name=name,
            team=sf.team,
            area_path=sf.area_path,
            iteration_path=sf.iteration_path,
            assignee=sf.assignee,
            active=(name == runtime.scope_key),
        )
        for name, sf in entry.scopes.items()
    ]


@router.get("", response_model=list[ScopeDTO])
def list_scopes(runtime: RuntimeState = Depends(get_runtime)) -> list[ScopeDTO]:
    return _entry_scopes(runtime)


@router.get("/active", response_model=ScopeDTO)
def active_scope(runtime: RuntimeState = Depends(get_runtime)) -> ScopeDTO:
    entry = runtime.config.providers[runtime.provider_key]
    sf = entry.scopes[runtime.scope_key]
    return ScopeDTO(
        name=runtime.scope_key,
        team=sf.team,
        area_path=sf.area_path,
        iteration_path=sf.iteration_path,
        assignee=sf.assignee,
        active=True,
    )


@router.put(
    "/active",
    response_model=ScopeDTO,
    dependencies=[Depends(require_not_read_only)],
)
def set_active_scope(
    payload: ScopeSwitchRequest,
    runtime: RuntimeState = Depends(get_runtime),
) -> ScopeDTO:
    try:
        runtime.switch_scope(payload.name)
    except KeyError as e:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown scope '{payload.name}' on provider '{runtime.provider_key}'",
        ) from e
    # View change is render-only — the project, agent, and MCP fleet stay
    # bound to the provider. No agent rebuild required.
    entry = runtime.config.providers[runtime.provider_key]
    sf = entry.scopes[runtime.scope_key]
    return ScopeDTO(
        name=runtime.scope_key,
        team=sf.team,
        area_path=sf.area_path,
        iteration_path=sf.iteration_path,
        assignee=sf.assignee,
        active=True,
    )


__all__ = ["router"]
