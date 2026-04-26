"""Scope listing and active-view switching.

Views are visual filters — switching the active view doesn't change the
project, the MCP fleet, or the agent's tool registry. The frontend is
expected to re-query the item list after a successful switch so the new
filter is applied at render time."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.deps import get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import ScopeDTO, ScopeSwitchRequest
from docket.config.models import ScopeFilter

router = APIRouter(prefix="/scopes", tags=["scopes"])


def _scope_dto(name: str, sf: ScopeFilter, *, active: bool) -> ScopeDTO:
    return ScopeDTO(
        name=name,
        assignee=sf.assignee,
        axes=dict(sf.axes),
        active=active,
    )


def _active_scope_dto(runtime: RuntimeState) -> ScopeDTO:
    entry = runtime.config.providers[runtime.provider_key]
    return _scope_dto(runtime.scope_key, entry.scopes[runtime.scope_key], active=True)


@router.get("", response_model=list[ScopeDTO])
def list_scopes(runtime: RuntimeState = Depends(get_runtime)) -> list[ScopeDTO]:
    entry = runtime.config.providers[runtime.provider_key]
    return [
        _scope_dto(name, sf, active=(name == runtime.scope_key))
        for name, sf in entry.scopes.items()
    ]


@router.get("/active", response_model=ScopeDTO)
def active_scope(runtime: RuntimeState = Depends(get_runtime)) -> ScopeDTO:
    return _active_scope_dto(runtime)


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
    return _active_scope_dto(runtime)


__all__ = ["router"]
