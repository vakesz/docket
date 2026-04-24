"""First-time-setup surface (HTTP equivalent of `docket setup`).

Mounted on both the full `create_app` and the bootstrap app spun up when
`config.toml` doesn't exist yet. In bootstrap mode only `/setup/*` and
`/health` are exposed, gated by `DOCKET_SETUP_TOKEN`. Once setup completes
the server writes config and exits so the user can re-run `docket serve`
with real wiring.

`GET /setup/status` is the one endpoint that stays auth-free — the frontend
needs to probe which mode it's in before it knows which token to send."""

from __future__ import annotations

import contextlib
import os
import secrets
import signal
import threading
import time
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import HttpUrl, ValidationError

from docket.api.auth import require_setup_token
from docket.api.deps import get_paths
from docket.api.schemas import (
    SetupCompleteDTO,
    SetupCompleteRequest,
    SetupProviderFieldDTO,
    SetupProviderTypeDTO,
    SetupStatusDTO,
    SetupTestLlmRequest,
    SetupTestProviderRequest,
    SetupTestResultDTO,
    SyncSummaryDTO,
)
from docket.config.loader import ConfigMissingError, load_config, save_config
from docket.config.models import (
    Config,
    HttpConfig,
    LlmConfig,
    ProviderEntry,
    ScopeFilter,
    TelemetryConfig,
)
from docket.config.paths import Paths
from docket.config.prompt_templates import scaffold as scaffold_prompts
from docket.core.services import sync_service
from docket.providers.base import ProviderError
from docket.providers.registry import UnknownProviderError
from docket.providers.registry import build as build_provider
from docket.providers.registry import specs as provider_specs
from docket.storage import init_db

router = APIRouter(prefix="/setup", tags=["setup"])


@router.get("/status", response_model=SetupStatusDTO)
def setup_status(paths: Paths = Depends(get_paths)) -> SetupStatusDTO:
    try:
        cfg = load_config(paths)
    except ConfigMissingError:
        return SetupStatusDTO(
            needs_setup=True,
            config_path=str(paths.config_file),
        )
    except ValidationError:
        return SetupStatusDTO(
            needs_setup=True,
            config_path=str(paths.config_file),
        )
    return SetupStatusDTO(
        needs_setup=False,
        config_path=str(paths.config_file),
        providers_configured=len(cfg.providers),
        active_provider=cfg.active_provider,
        llm_configured=bool(cfg.llm.endpoint),
        http_configured=bool(cfg.http.token),
    )


@router.get(
    "/providers/types",
    response_model=list[SetupProviderTypeDTO],
    dependencies=[Depends(require_setup_token)],
)
def provider_types() -> list[SetupProviderTypeDTO]:
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
    "/test-provider",
    response_model=SetupTestResultDTO,
    dependencies=[Depends(require_setup_token)],
)
def test_provider(req: SetupTestProviderRequest) -> SetupTestResultDTO:
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
    "/test-llm",
    response_model=SetupTestResultDTO,
    dependencies=[Depends(require_setup_token)],
)
def test_llm(req: SetupTestLlmRequest) -> SetupTestResultDTO:
    if not req.endpoint or not req.api_key:
        return SetupTestResultDTO(ok=False, error="endpoint and api_key are required")
    try:
        from docket.agent.llm_client import AzureOpenAIClient
    except ImportError as e:
        return SetupTestResultDTO(ok=False, error=f"openai SDK not installed: {e}")
    try:
        client = AzureOpenAIClient(
            endpoint=req.endpoint,
            api_key=req.api_key,
            deployment=req.deployment,
            api_version=req.api_version,
        )
        client.complete(
            messages=[{"role": "user", "content": "ping"}],  # type: ignore[list-item]
            tools=[],
        )
    except Exception as e:
        return SetupTestResultDTO(ok=False, error=f"{type(e).__name__}: {e}")
    return SetupTestResultDTO(ok=True)


@router.post(
    "/complete",
    response_model=SetupCompleteDTO,
    dependencies=[Depends(require_setup_token)],
)
def setup_complete(
    req: SetupCompleteRequest,
    background: BackgroundTasks,
    paths: Paths = Depends(get_paths),
) -> SetupCompleteDTO:
    if req.active_provider not in req.providers:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"active_provider '{req.active_provider}' is not in providers map",
        )
    if not req.providers:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="at least one provider is required",
        )

    http_token = req.http_token or secrets.token_urlsafe(32)

    providers_cfg: dict[str, ProviderEntry] = {}
    built_providers: dict[str, Any] = {}
    for key, entry in req.providers.items():
        normalized = _normalize_provider_config(entry.type, dict(entry.config))
        try:
            built = build_provider(
                entry.type, dict(normalized), display_name=entry.display_name or key
            )
        except UnknownProviderError as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=str(e),
            ) from e
        except (ValueError, ValidationError) as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"invalid config for '{key}': {e}",
            ) from e
        try:
            scope = ScopeFilter(**dict(entry.scope))
        except ValidationError as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"invalid scope for '{key}': {e}",
            ) from e
        providers_cfg[key] = ProviderEntry(
            type=entry.type,
            display_name=entry.display_name or key,
            config=normalized,
            scopes={"default": scope},
            active_scope="default",
        )
        built_providers[key] = built

    llm_cfg = LlmConfig()
    if req.llm is not None:
        try:
            llm_cfg = LlmConfig(endpoint=req.llm.endpoint, deployment=req.llm.deployment)
        except ValidationError as e:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"invalid llm config: {e}",
            ) from e

    cfg = Config(
        providers=providers_cfg,
        active_provider=req.active_provider,
        llm=llm_cfg,
        http=HttpConfig(
            enabled=True,
            bind=req.http_bind,
            port=req.http_port,
            token=http_token,
        ),
        telemetry=TelemetryConfig(
            enabled=req.telemetry_enabled,
            level=req.telemetry_level,
        ),
    )

    paths.ensure()
    scaffold_prompts(paths.prompts_dir)
    save_config(paths, cfg)
    if req.llm is not None and req.llm.api_key:
        _write_env_key(paths, req.llm.api_key)

    initial_sync: SyncSummaryDTO | None = None
    if req.run_initial_sync:
        provider = built_providers[req.active_provider]
        conn = init_db(paths.db_file)
        try:
            summary = sync_service.full_refresh(conn, provider, provider_key=req.active_provider)
            initial_sync = SyncSummaryDTO(
                upserted=summary.upserted,
                archived=summary.archived,
                watermark=summary.watermark,
                offline=False,
            )
        except ProviderError as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"initial sync failed: {e}",
            ) from e
        finally:
            conn.close()

    background.add_task(_schedule_restart)
    return SetupCompleteDTO(
        ok=True,
        config_path=str(paths.config_file),
        http_token=http_token,
        restart_required=True,
        initial_sync=initial_sync,
    )


def _normalize_provider_config(type_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Minor coercions that mirror what the interactive wizard does."""
    if type_id == "azure_devops":
        org = str(config.get("organization", "")).rstrip("/")
        try:
            config["organization"] = str(HttpUrl(org))
        except ValidationError as e:
            raise ValueError(f"organization must be a valid URL: {e}") from e
        project = str(config.get("project", "")).strip()
        if not project:
            raise ValueError("project is required")
        config["project"] = project
    return config


def _write_env_key(paths: Paths, api_key: str) -> None:
    """Persist AZURE_OPENAI_API_KEY into XDG config .env so `docket serve` picks it up.

    Passing an empty string removes the entry. The runtime value is NOT
    rewritten by this function — callers can update `os.environ` directly if
    they want the change to take effect without restart."""
    env_path = paths.env_file
    lines: list[str] = []
    if env_path.exists():
        lines = env_path.read_text(encoding="utf-8").splitlines()
        lines = [ln for ln in lines if not ln.strip().startswith("AZURE_OPENAI_API_KEY=")]
    if api_key:
        lines.append(f"AZURE_OPENAI_API_KEY={api_key}")
    env_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    with contextlib.suppress(OSError):
        os.chmod(env_path, 0o600)


def _schedule_restart() -> None:
    """Fire SIGTERM on self after a short delay so the response can flush first.

    The user's `docket serve` process exits and they re-run it with the
    freshly-written config."""

    def _die() -> None:
        time.sleep(0.5)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_die, daemon=True).start()


__all__ = ["router"]
