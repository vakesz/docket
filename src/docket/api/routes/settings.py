"""Settings read + patch endpoints.

Maps 1:1 to `config.toml`. GET returns the full Config with `http.token` masked.
PATCH takes a deep-partial merge and writes atomically via `save_config`. Some
fields (providers, http.bind/port, llm.*, sync.background_interval_seconds)
take effect only on restart — we surface the list of changed top-level sections
that need one in the `requires_restart` response field.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.auth import require_bearer
from docket.api.deps import get_paths, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import SettingsDTO, SettingsPatchRequest, SettingsUpdatedDTO
from docket.config.loader import save_config
from docket.config.models import Config
from docket.config.paths import Paths

router = APIRouter(
    prefix="/settings",
    tags=["settings"],
    dependencies=[Depends(require_bearer)],
)


_RESTART_SECTIONS = frozenset({"providers", "active_provider", "llm", "http", "sync"})


def _mask_config(cfg: Config) -> dict[str, Any]:
    data = cfg.model_dump(mode="json")
    token = cfg.http.token
    if token:
        data.setdefault("http", {})["token"] = (
            "••••••••" + token[-4:] if len(token) > 4 else "••••••••"
        )
    else:
        data.setdefault("http", {})["token"] = ""
    return data


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def _has_real_changes(
    section: str, old: dict[str, Any], new: dict[str, Any], patch: dict[str, Any]
) -> bool:
    if section not in patch:
        return False
    return old.get(section) != new.get(section)


@router.get("", response_model=SettingsDTO)
def get_settings(runtime: RuntimeState = Depends(get_runtime)) -> SettingsDTO:
    return SettingsDTO(config=_mask_config(runtime.config))


@router.patch(
    "",
    response_model=SettingsUpdatedDTO,
    dependencies=[Depends(require_not_read_only)],
)
def patch_settings(
    payload: SettingsPatchRequest,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SettingsUpdatedDTO:
    # The client may have received a masked token and echoed it back. Drop any
    # masked value so we don't overwrite the real one with bullets.
    patch = deepcopy(payload.patch or {})
    http_patch = patch.get("http")
    if isinstance(http_patch, dict) and "token" in http_patch:
        val = http_patch["token"]
        if isinstance(val, str) and val.startswith("••••••••"):
            http_patch.pop("token", None)
            if not http_patch:
                patch.pop("http", None)

    base = runtime.config.model_dump(mode="json")
    merged_raw = _deep_merge(base, patch)
    try:
        merged = Config.model_validate(merged_raw)
    except Exception as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Config validation failed: {e}",
        ) from e

    save_config(paths, merged)

    requires_restart: list[str] = []
    new_dump = merged.model_dump(mode="json")
    for section in _RESTART_SECTIONS:
        if _has_real_changes(section, base, new_dump, patch):
            requires_restart.append(section)

    # Update in-memory config so subsequent reads reflect the patch. Provider
    # dict is NOT rebuilt here — that's what requires_restart communicates.
    runtime.config = merged

    return SettingsUpdatedDTO(
        config=_mask_config(merged),
        requires_restart=sorted(requires_restart),
    )


__all__ = ["router"]
