"""Session-only chip-bar overrides on top of the active saved view.

The chip bar lives above the items pane and lets the user tweak filters
(state/assignee/tags/axes) for the current session without overwriting
the saved view. Overrides are kept on `RuntimeState`, not in
`config.toml`, so they vanish on restart and on provider switch — the
"session-only" semantic the chip bar promises.

`PATCH` replaces the override outright; `DELETE` clears it so the saved
view shows through. `GET` returns the merged effective view plus a flag
indicating whether overrides are currently in effect."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from docket.api.deps import get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import SavedViewDTO, ViewOverrideDTO, ViewOverridePatch
from docket.config.models import SavedView

router = APIRouter(prefix="/runtime/view-overrides", tags=["views"])


def _override_dto(runtime: RuntimeState) -> ViewOverrideDTO:
    return ViewOverrideDTO(
        present=runtime.has_view_overrides,
        view=SavedViewDTO.from_core(
            runtime.active_view_name,
            runtime.effective_view,
            active=True,
        ),
    )


@router.get("", response_model=ViewOverrideDTO)
def get_overrides(runtime: RuntimeState = Depends(get_runtime)) -> ViewOverrideDTO:
    return _override_dto(runtime)


@router.patch(
    "",
    response_model=ViewOverrideDTO,
    dependencies=[Depends(require_not_read_only)],
)
def patch_overrides(
    payload: ViewOverridePatch,
    runtime: RuntimeState = Depends(get_runtime),
) -> ViewOverrideDTO:
    runtime.set_view_overrides(
        SavedView(
            assignees=list(payload.assignees),
            axes={k: list(v) for k, v in payload.axes.items()},
            state_bucket=payload.state_bucket,
        )
    )
    return _override_dto(runtime)


@router.delete(
    "",
    response_model=ViewOverrideDTO,
    dependencies=[Depends(require_not_read_only)],
)
def clear_overrides(runtime: RuntimeState = Depends(get_runtime)) -> ViewOverrideDTO:
    runtime.set_view_overrides(None)
    return _override_dto(runtime)


__all__ = ["router"]
