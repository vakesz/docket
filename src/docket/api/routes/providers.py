"""Provider listing and active-provider switching.

Switching is session-scoped — we do *not* persist to `config.toml`. This
matches the TUI's palette-driven provider switch. To permanently change the
default provider, edit `active_provider` via `PATCH /settings`."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.auth import require_bearer
from docket.api.deps import get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import ProviderDTO, ProviderSwitchRequest

router = APIRouter(
    prefix="/providers",
    tags=["providers"],
    dependencies=[Depends(require_bearer)],
)


def _to_dto(runtime: RuntimeState, key: str) -> ProviderDTO:
    entry = runtime.config.providers[key]
    return ProviderDTO(
        key=key,
        type=entry.type,
        display_name=entry.display_name,
        scopes=sorted(entry.scopes),
        active_scope=entry.active_scope,
        active=(key == runtime.provider_key),
    )


@router.get("", response_model=list[ProviderDTO])
def list_providers(runtime: RuntimeState = Depends(get_runtime)) -> list[ProviderDTO]:
    return [_to_dto(runtime, key) for key in sorted(runtime.providers)]


@router.get("/active", response_model=ProviderDTO)
def active_provider(runtime: RuntimeState = Depends(get_runtime)) -> ProviderDTO:
    return _to_dto(runtime, runtime.provider_key)


@router.put(
    "/active",
    response_model=ProviderDTO,
    dependencies=[Depends(require_not_read_only)],
)
def set_active_provider(
    payload: ProviderSwitchRequest,
    runtime: RuntimeState = Depends(get_runtime),
) -> ProviderDTO:
    try:
        runtime.switch_provider(payload.key)
    except KeyError as e:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider '{payload.key}' (known: {sorted(runtime.providers)})",
        ) from e
    return _to_dto(runtime, runtime.provider_key)


__all__ = ["router"]
