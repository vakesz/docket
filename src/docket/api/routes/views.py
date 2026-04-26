"""Saved-view CRUD + active-view switching for the current provider.

Saved views are the persisted defaults the chip bar starts from. CRUD
edits land in `config.toml`; activating one updates the runtime so the
next `/api/items` query renders against it. Session-only chip-bar
overrides live elsewhere (`/api/runtime/view-overrides`) so a user can
tweak chips without overwriting the saved view.

Deleting the active view auto-switches to another (alphabetical first);
deleting the last view auto-recreates `default` so a provider always has
at least one view selectable.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, status

from docket.api.deps import get_paths, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState, rebuild_agent
from docket.api.schemas import (
    SavedViewDTO,
    SavedViewWriteRequest,
    ViewSwitchRequest,
)
from docket.config.loader import save_config
from docket.config.models import SavedView
from docket.config.paths import Paths

router = APIRouter(prefix="/providers/{provider_key}/views", tags=["views"])


def _ensure_provider(runtime: RuntimeState, provider_key: str) -> None:
    if provider_key not in runtime.config.providers:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown provider '{provider_key}'",
        )


def _view_dto(name: str, view: SavedView, *, active: bool) -> SavedViewDTO:
    return SavedViewDTO.from_core(name, view, active=active)


@router.get("", response_model=list[SavedViewDTO])
def list_views(
    provider_key: str,
    runtime: RuntimeState = Depends(get_runtime),
) -> list[SavedViewDTO]:
    _ensure_provider(runtime, provider_key)
    entry = runtime.config.providers[provider_key]
    return [
        _view_dto(name, view, active=(name == entry.active_view))
        for name, view in entry.views.items()
    ]


@router.get("/active", response_model=SavedViewDTO)
def active_view(
    provider_key: str,
    runtime: RuntimeState = Depends(get_runtime),
) -> SavedViewDTO:
    _ensure_provider(runtime, provider_key)
    entry = runtime.config.providers[provider_key]
    view = entry.views.get(entry.active_view, SavedView())
    return _view_dto(entry.active_view, view, active=True)


@router.put(
    "/active",
    response_model=SavedViewDTO,
    dependencies=[Depends(require_not_read_only)],
)
def set_active_view(
    provider_key: str,
    payload: ViewSwitchRequest,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SavedViewDTO:
    _ensure_provider(runtime, provider_key)
    entry = runtime.config.providers[provider_key]
    if payload.name not in entry.views:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown view '{payload.name}' on provider '{provider_key}'",
        )
    entry.active_view = payload.name
    if provider_key == runtime.provider_key:
        runtime.switch_view(payload.name)
    save_config(paths, runtime.config)
    return _view_dto(payload.name, entry.views[payload.name], active=True)


@router.put(
    "/{name}",
    response_model=SavedViewDTO,
    dependencies=[Depends(require_not_read_only)],
)
def upsert_view(
    provider_key: str,
    name: str,
    payload: SavedViewWriteRequest,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SavedViewDTO:
    _ensure_provider(runtime, provider_key)
    if not name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "View name must not be empty")
    entry = runtime.config.providers[provider_key]
    view = SavedView(
        assignees=list(payload.assignees),
        axes={k: list(v) for k, v in payload.axes.items()},
        state_bucket=payload.state_bucket,
    )
    entry.views[name] = view
    save_config(paths, runtime.config)
    if provider_key == runtime.provider_key and name == entry.active_view:
        # The active view changed under us — drop session overrides so the
        # user sees the updated saved view immediately.
        runtime.set_view_overrides(None)
    return _view_dto(name, view, active=(name == entry.active_view))


@router.delete(
    "/{name}",
    response_model=SavedViewDTO,
    dependencies=[Depends(require_not_read_only)],
)
def delete_view(
    provider_key: str,
    name: str,
    request: Request,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SavedViewDTO:
    _ensure_provider(runtime, provider_key)
    entry = runtime.config.providers[provider_key]
    if name not in entry.views:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown view '{name}' on provider '{provider_key}'",
        )
    del entry.views[name]
    if not entry.views:
        # A provider always needs at least one view; recreate the default
        # rather than leaving the user stuck with no selectable view.
        entry.views["default"] = SavedView()
    if entry.active_view == name:
        # Auto-switch to the alphabetically-first remaining view so the
        # caller doesn't end up referencing a deleted active.
        entry.active_view = sorted(entry.views)[0]
        if provider_key == runtime.provider_key:
            runtime.switch_view(entry.active_view)
            rebuild_agent(request.app, runtime)
    save_config(paths, runtime.config)
    new_active_name = entry.active_view
    new_active = entry.views[new_active_name]
    return _view_dto(new_active_name, new_active, active=True)


__all__ = ["router"]
