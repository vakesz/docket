"""Settings read + patch endpoints.

Maps 1:1 to `config.toml`. GET returns the full Config with `http.token` masked.
PATCH takes a deep-partial merge and writes atomically via `save_config`. Some
fields (providers, http.bind/port, llm.*, sync.background_interval_seconds)
take effect only on restart — we surface the list of changed top-level sections
that need one in the `requires_restart` response field.

Also exposes admin operations the first-run wizard covers (provider add/remove,
LLM key rotation, HTTP token regen, provider type discovery + draft test) so
the frontend Settings page can act as a running-system wizard without
re-entering bootstrap mode.
"""

from __future__ import annotations

import os
import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError

from docket.api.auth import require_bearer
from docket.api.deps import get_paths, get_runtime, require_not_read_only
from docket.api.routes.setup import _write_env_key
from docket.api.runtime import RuntimeState
from docket.api.schemas import (
    SettingsDTO,
    SettingsHttpTokenDTO,
    SettingsLlmKeyDTO,
    SettingsLlmKeyRequest,
    SettingsPatchRequest,
    SettingsProviderAddRequest,
    SettingsProviderUpdateRequest,
    SettingsUpdatedDTO,
    SetupProviderFieldDTO,
    SetupProviderTypeDTO,
    SetupTestProviderRequest,
    SetupTestResultDTO,
)
from docket.config.loader import save_config
from docket.config.models import Config, ScopeFilter, build_provider_entry
from docket.config.paths import Paths
from docket.core.services import settings_service
from docket.providers import registry
from docket.providers.base import ProviderError
from docket.providers.registry import UnknownProviderError
from docket.providers.registry import build as build_provider
from docket.providers.registry import specs as provider_specs

router = APIRouter(
    prefix="/settings",
    tags=["settings"],
    dependencies=[Depends(require_bearer)],
)


@router.get("", response_model=SettingsDTO)
def get_settings(runtime: RuntimeState = Depends(get_runtime)) -> SettingsDTO:
    return SettingsDTO(config=settings_service.mask_http_token(runtime.config))


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
    try:
        result = settings_service.patch_settings(runtime.config, payload.patch or {})
    except settings_service.SettingsValidationError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e

    save_config(paths, result.config)
    # Update in-memory config so subsequent reads reflect the patch. Provider
    # dict is NOT rebuilt here — that's what requires_restart communicates.
    runtime.config = result.config

    return SettingsUpdatedDTO(
        config=settings_service.mask_http_token(result.config),
        requires_restart=result.requires_restart,
    )


# -- LLM key rotation ---------------------------------------------------------


@router.post(
    "/llm-key",
    response_model=SettingsLlmKeyDTO,
    dependencies=[Depends(require_not_read_only)],
)
def rotate_llm_key(
    payload: SettingsLlmKeyRequest,
    paths: Paths = Depends(get_paths),
) -> SettingsLlmKeyDTO:
    """Set / clear AZURE_OPENAI_API_KEY in the XDG `.env` file.

    Also updates the current process's `os.environ` so components that read
    `get_llm_api_key()` at call time see the new value. The live `LlmClient`
    still holds the old key in its SDK config — fully rebinding chat requires
    a restart, which we signal via `requires_restart=True` when the key
    actually changed."""
    key = payload.api_key.strip()
    previous = os.environ.get("AZURE_OPENAI_API_KEY", "")
    _write_env_key(paths, key)
    if key:
        os.environ["AZURE_OPENAI_API_KEY"] = key
    else:
        os.environ.pop("AZURE_OPENAI_API_KEY", None)
    changed = (key or "") != (previous or "")
    return SettingsLlmKeyDTO(
        ok=True,
        configured=bool(key),
        requires_restart=changed,
    )


# -- HTTP token regeneration --------------------------------------------------


@router.post(
    "/http-token/regenerate",
    response_model=SettingsHttpTokenDTO,
    dependencies=[Depends(require_not_read_only)],
)
def regenerate_http_token(
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SettingsHttpTokenDTO:
    """Mint a fresh bearer token and persist it.

    The caller must save the returned token immediately — `GET /settings`
    will mask it on subsequent reads. A restart is still required: the
    running app's `app.state.bearer_token` is not rewritten here because the
    client would be logged out mid-flight; telling the user to restart keeps
    the contract simple and matches how the wizard treats it."""
    new_token = secrets.token_urlsafe(32)
    cfg_dump = runtime.config.model_dump(mode="json")
    cfg_dump.setdefault("http", {})["token"] = new_token
    try:
        merged = Config.model_validate(cfg_dump)
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            f"Failed to persist new token: {e}",
        ) from e
    save_config(paths, merged)
    runtime.config = merged
    return SettingsHttpTokenDTO(token=new_token, requires_restart=True)


# -- Provider admin (post-bootstrap) -----------------------------------------


@router.get("/providers/types", response_model=list[SetupProviderTypeDTO])
def provider_types() -> list[SetupProviderTypeDTO]:
    """Bearer-authed equivalent of `GET /setup/providers/types`.

    Same shape — the wizard UI on the frontend consumes both forms from the
    same component, but post-bootstrap callers use this path so they don't
    need the setup token."""
    return [
        SetupProviderTypeDTO(
            id=spec.type_id,
            display=spec.display_name,
            requires_cli=list(spec.requires_cli),
            fields=[
                SetupProviderFieldDTO(
                    key=f.key,
                    label=f.label,
                    kind=f.kind,
                    required=f.required,
                    placeholder=f.placeholder,
                    help=f.help,
                )
                for f in spec.setup_fields
            ],
        )
        for spec in provider_specs()
    ]


@router.post(
    "/providers/test",
    response_model=SetupTestResultDTO,
    dependencies=[Depends(require_not_read_only)],
)
def test_provider_draft(req: SetupTestProviderRequest) -> SetupTestResultDTO:
    """Dry-run a provider config without persisting it."""
    try:
        provider = build_provider(req.type, dict(req.config), display_name=req.type)
    except UnknownProviderError as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    except (ValueError, ValidationError) as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    try:
        provider.health_check()
    except ProviderError as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    except Exception as e:
        return SetupTestResultDTO(ok=False, error=f"{type(e).__name__}: {e}")
    return SetupTestResultDTO(ok=True)


@router.post(
    "/providers",
    response_model=SettingsUpdatedDTO,
    dependencies=[Depends(require_not_read_only)],
)
def add_provider(
    payload: SettingsProviderAddRequest,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SettingsUpdatedDTO:
    """Register a new provider entry at runtime.

    Mirrors `docket setup provider add` / the wizard, but scoped to a running
    server. Validates the config by building a live provider instance and
    adds it to both the on-disk config and the in-memory `runtime.providers`
    dict so the frontend can switch to it immediately."""
    key = payload.key.strip()
    if not key:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "key is required")
    if key in runtime.config.providers:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Provider '{key}' already exists. Remove it first or pick a new key.",
        )

    try:
        normalized = registry.normalize_config(payload.type, dict(payload.config))
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e

    try:
        built = build_provider(
            payload.type, dict(normalized), display_name=payload.display_name or key
        )
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except (ValueError, ValidationError) as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid config for '{key}': {e}",
        ) from e

    try:
        scope = ScopeFilter(**dict(payload.scope))
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid scope for '{key}': {e}",
        ) from e

    entry = build_provider_entry(
        type_id=payload.type,
        display_name=payload.display_name or key,
        config=normalized,
        scope=scope,
    )

    cfg_dump = runtime.config.model_dump(mode="json")
    cfg_dump.setdefault("providers", {})[key] = entry.model_dump(mode="json")
    if payload.make_active or not cfg_dump.get("active_provider"):
        cfg_dump["active_provider"] = key
    try:
        merged = Config.model_validate(cfg_dump)
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Config validation failed: {e}",
        ) from e

    save_config(paths, merged)
    runtime.config = merged
    runtime.providers[key] = built

    return SettingsUpdatedDTO(
        config=settings_service.mask_http_token(merged),
        requires_restart=["providers"],
    )


@router.put(
    "/providers/{key}",
    response_model=SettingsUpdatedDTO,
    dependencies=[Depends(require_not_read_only)],
)
def update_provider(
    key: str,
    payload: SettingsProviderUpdateRequest,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SettingsUpdatedDTO:
    """Update an existing provider's display_name and config in place.

    `type` and `key` are immutable here — those identify the provider in
    project metadata, cached items, and downstream tool names, so changing
    them mid-stream would orphan rows. Callers who need a different type
    should remove + re-add."""
    if key not in runtime.config.providers:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown provider '{key}'")
    existing = runtime.config.providers[key]

    try:
        normalized = registry.normalize_config(existing.type, dict(payload.config))
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e

    display_name = payload.display_name or existing.display_name or key
    try:
        built = build_provider(existing.type, dict(normalized), display_name=display_name)
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except (ValueError, ValidationError) as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid config for '{key}': {e}",
        ) from e

    if payload.scope is None:
        scope = existing.scopes.get(existing.active_scope, ScopeFilter())
    else:
        try:
            scope = ScopeFilter(**dict(payload.scope))
        except ValidationError as e:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"invalid scope for '{key}': {e}",
            ) from e

    entry = build_provider_entry(
        type_id=existing.type,
        display_name=display_name,
        config=normalized,
        scope=scope,
        existing=existing,
    )

    cfg_dump = runtime.config.model_dump(mode="json")
    cfg_dump.setdefault("providers", {})[key] = entry.model_dump(mode="json")
    try:
        merged = Config.model_validate(cfg_dump)
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Config validation failed: {e}",
        ) from e

    save_config(paths, merged)
    runtime.config = merged
    # Swap the live provider so subsequent requests use the new credentials
    # without a restart. The agent loop still reads `requires_restart` and
    # may need a rebuild for cached tool closures.
    runtime.providers[key] = built

    return SettingsUpdatedDTO(
        config=settings_service.mask_http_token(merged),
        requires_restart=["providers"],
    )


@router.delete(
    "/providers/{key}",
    response_model=SettingsUpdatedDTO,
    dependencies=[Depends(require_not_read_only)],
)
def remove_provider(
    key: str,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> SettingsUpdatedDTO:
    """Drop a provider entry from config.toml and the running runtime.

    Refuses to remove the currently-active provider — the caller must switch
    first. Removing the last provider is allowed; the UI is responsible for
    warning the user that chat / sync / mutations will 503 until another is
    added."""
    if key not in runtime.config.providers:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown provider '{key}'")
    if key == runtime.provider_key:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Cannot remove the active provider. Switch to another provider first.",
        )

    cfg_dump = runtime.config.model_dump(mode="json")
    cfg_dump.get("providers", {}).pop(key, None)
    if cfg_dump.get("active_provider") == key:
        remaining = sorted(cfg_dump.get("providers", {}))
        cfg_dump["active_provider"] = remaining[0] if remaining else ""
    # Project metadata keyed by provider key: drop the matching entry so we
    # don't leak orphan rows (sources/memory FKs are fine — those are tied
    # to the project_id which equals the provider key, and SQLite rows can
    # outlive the config dict).
    cfg_dump.get("projects", {}).pop(key, None)

    try:
        merged = Config.model_validate(cfg_dump)
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"Config validation failed: {e}",
        ) from e

    save_config(paths, merged)
    runtime.config = merged
    runtime.providers.pop(key, None)

    return SettingsUpdatedDTO(
        config=settings_service.mask_http_token(merged),
        requires_restart=["providers"],
    )


__all__ = ["router"]
