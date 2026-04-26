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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import ValidationError

from docket.agent.prompt import scaffold as scaffold_prompts
from docket.api._provider_setup import (
    build_and_validate_provider_entry,
    provider_type_dtos,
    test_provider_draft,
)
from docket.api.auth import require_setup_token
from docket.api.deps import get_paths
from docket.api.schemas import (
    SetupCompleteDTO,
    SetupCompleteRequest,
    SetupProviderTypeDTO,
    SetupStatusDTO,
    SetupTestLlmRequest,
    SetupTestProviderRequest,
    SetupTestResultDTO,
    SyncSummaryDTO,
)
from docket.config.loader import load_config, save_config
from docket.config.models import (
    ProviderEntry,
    compose_setup_config,
)
from docket.config.paths import Paths
from docket.core.services import sync_service
from docket.providers.base import ProviderError, WorkItemProvider
from docket.storage import init_db

router = APIRouter(prefix="/setup", tags=["setup"])


@router.get("/status", response_model=SetupStatusDTO)
def setup_status(paths: Paths = Depends(get_paths)) -> SetupStatusDTO:
    try:
        cfg = load_config(paths, optional=True)
    except ValidationError:
        cfg = None
    if cfg is None:
        return SetupStatusDTO(needs_setup=True, config_path=str(paths.config_file))
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
    return provider_type_dtos()


@router.post(
    "/test-provider",
    response_model=SetupTestResultDTO,
    dependencies=[Depends(require_setup_token)],
)
def test_provider(req: SetupTestProviderRequest) -> SetupTestResultDTO:
    return test_provider_draft(req.type, dict(req.config))


@router.post(
    "/test-llm",
    response_model=SetupTestResultDTO,
    dependencies=[Depends(require_setup_token)],
)
def test_llm(req: SetupTestLlmRequest) -> SetupTestResultDTO:
    if not req.endpoint or not req.api_key:
        return SetupTestResultDTO(ok=False, error="endpoint and api_key are required")
    try:
        from docket.agent.llm_client import AzureOpenAIClient, accumulate_stream
        from docket.agent.types import ChatMessage
    except ImportError as e:
        return SetupTestResultDTO(ok=False, error=f"openai SDK not installed: {e}")
    try:
        client = AzureOpenAIClient(
            endpoint=req.endpoint,
            api_key=req.api_key,
            deployment=req.deployment,
            api_version=req.api_version,
        )
        accumulate_stream(client.stream([ChatMessage(role="user", content="ping")], []))
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

    # Load any pre-existing config so we preserve per-provider extra scope
    # slots / active_scope choices when the wizard is re-run against a
    # configured instance. Bootstrap mode will return None here.
    try:
        existing_cfg = load_config(paths, optional=True)
    except ValidationError:
        existing_cfg = None

    providers_cfg: dict[str, ProviderEntry] = {}
    built_providers: dict[str, WorkItemProvider] = {}
    for key, entry in req.providers.items():
        provider_entry, built = build_and_validate_provider_entry(
            key=key,
            type_id=entry.type,
            display_name=entry.display_name,
            config=dict(entry.config),
            scope=dict(entry.scope),
            existing=existing_cfg.providers.get(key) if existing_cfg else None,
        )
        providers_cfg[key] = provider_entry
        built_providers[key] = built

    llm_endpoint = req.llm.endpoint if req.llm is not None else None
    llm_deployment = req.llm.deployment if req.llm is not None else "gpt-5"
    price_input = req.llm.price_input_per_1m if req.llm is not None else None
    price_output = req.llm.price_output_per_1m if req.llm is not None else None
    try:
        cfg = compose_setup_config(
            existing_cfg,
            providers=providers_cfg,
            active_provider=req.active_provider,
            telemetry_enabled=req.telemetry_enabled,
            telemetry_level=req.telemetry_level,
            http_enabled=True,
            http_bind=req.http_bind,
            http_port=req.http_port,
            http_token=http_token,
            llm_endpoint=llm_endpoint,
            llm_deployment=llm_deployment,
            price_input_per_1m=price_input,
            price_output_per_1m=price_output,
        )
    except ValidationError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"invalid llm config: {e}",
        ) from e

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
