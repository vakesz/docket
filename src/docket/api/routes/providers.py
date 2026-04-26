"""Provider listing and active-provider switching.

Switching is session-scoped — we do *not* persist to `config.toml`. This
matches the TUI's palette-driven provider switch. To permanently change the
default provider, edit `active_provider` via `PATCH /settings`."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from docket.api.deps import get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState, rebuild_agent
from docket.api.schemas import ProviderDTO, ProviderSwitchRequest
from docket.core.services.proposal_store import ProposalStore
from docket.providers.registry import spec as provider_spec

router = APIRouter(prefix="/providers", tags=["providers"])


def _to_dto(runtime: RuntimeState, key: str) -> ProviderDTO:
    entry = runtime.config.providers[key]
    spec = provider_spec(entry.type)
    kinds = [k.value for k in spec.supported_kinds] if spec is not None else []
    return ProviderDTO(
        key=key,
        type=entry.type,
        display_name=entry.display_name,
        views=sorted(entry.views),
        active_view=entry.active_view,
        active=(key == runtime.provider_key),
        supported_kinds=kinds,
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
    request: Request,
    runtime: RuntimeState = Depends(get_runtime),
) -> ProviderDTO:
    try:
        runtime.switch_provider(payload.key)
    except KeyError as e:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider '{payload.key}' (known: {sorted(runtime.providers)})",
        ) from e
    # Pending proposals embed an `Item` that carries the *previous* provider's
    # provider_key. Confirming after a switch would route the staged change
    # through `mutation_service.confirm` with the new active provider — i.e.
    # apply an Azure-staged transition/comment/description-patch against the
    # GitHub item that happens to share the same id. Drop them so a stale
    # proposal can't be confirmed against the wrong backend. Mirrors the
    # `question_store.clear()` already done inside `rebuild_agent`.
    proposals = getattr(request.app.state, "proposals", None)
    if isinstance(proposals, ProposalStore):
        proposals.clear()
    # The agent's tool closures captured the previous provider + provider_key
    # at create_app time. Rebuild so tool calls hit the new backend; otherwise
    # chat in the same session keeps reasoning over the old provider's items.
    rebuild_agent(request.app, runtime)
    return _to_dto(runtime, runtime.provider_key)


__all__ = ["router"]
