"""First-time-setup surface (HTTP equivalent of `docket setup`).

Mounted on both the full `create_app` and the bootstrap app spun up when
`config.toml` doesn't exist yet. In bootstrap mode only `/setup/*` and
`/health` are exposed, gated by the bootstrap bearer token (`docket serve`
mints one into `[http].token` on first run and prints it). Once setup
completes the server writes config and exits so the user can re-run
`docket serve` with real wiring.

`GET /setup/status` is the one endpoint that stays auth-free — the frontend
needs to probe which mode it's in before it knows which token to send."""

from __future__ import annotations

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
    count_items_for_scope,
    provider_type_dtos,
    test_provider_draft,
)
from docket.api.auth import require_setup_token
from docket.api.deps import get_paths
from docket.api.schemas import (
    CliStatusDTO,
    CliToolStatusDTO,
    DiscoverRequest,
    DiscoverResultDTO,
    DiscoveryItemDTO,
    GithubHostDTO,
    ProbeScopeDTO,
    ProbeScopeRequest,
    SetupCompleteDTO,
    SetupCompleteRequest,
    SetupProviderTypeDTO,
    SetupStatusDTO,
    SetupTestLlmRequest,
    SetupTestProviderRequest,
    SetupTestResultDTO,
    SuggestKeyDTO,
    SuggestKeyRequest,
    SuggestLabelDTO,
    SuggestLabelRequest,
    SyncSummaryDTO,
)
from docket.config import setup_discovery, setup_hooks
from docket.config.loader import load_config, save_config
from docket.config.models import (
    ProviderEntry,
    ScopeFilter,
    compose_setup_config,
)
from docket.config.paths import Paths
from docket.config.secrets import keyring_available, set_llm_api_key
from docket.config.setup_utils import build_label_suggestion, next_sibling_key
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

    # Persist the API key + hint *before* save_config so the saved file
    # already carries the freshly-rotated `[llm.key_hint]`. Failure to
    # reach the OS keyring is a 503 — the user will retry from the wizard.
    if req.llm is not None and req.llm.api_key:
        ok, err = keyring_available()
        if not ok:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"OS keyring unavailable: {err or 'no backend detected'}",
            )
        try:
            hint = set_llm_api_key(req.llm.api_key)
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=f"failed to write API key to keyring: {e}",
            ) from e
        cfg = cfg.model_copy(update={"llm": cfg.llm.model_copy(update={"key_hint": hint})})

    save_config(paths, cfg)

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


@router.get("/cli-status", response_model=CliStatusDTO)
def cli_status() -> CliStatusDTO:
    """Probe the local `gh` / `az` CLI sessions and OS keyring.

    Auth-free so the SPA can read it before it has a token to send. Each
    sub-probe is best-effort: if `gh` isn't installed we report
    `present=false` rather than 500ing. Identity is reported only when
    the session is live, mirroring the CLI wizard's "Checking … session"
    line. The `gh_hosts` list reflects every authenticated `gh auth login`
    target so the GitHub picker can disambiguate cloud vs. enterprise."""
    az = setup_discovery.probe_az()
    gh = setup_discovery.probe_gh()
    gh_hosts: list[GithubHostDTO] = []
    if gh.logged_in:
        gh_hosts = [
            GithubHostDTO(hostname=h.hostname, api_base_url=h.api_base_url)
            for h in setup_discovery.list_gh_hosts()
        ]
    keyring_ok, keyring_err = keyring_available()
    return CliStatusDTO(
        az=_to_cli_dto(az),
        gh=_to_cli_dto(gh),
        gh_hosts=gh_hosts,
        keyring_available=keyring_ok,
        keyring_error=keyring_err or "",
    )


def _to_cli_dto(status: setup_discovery.CliToolStatus) -> CliToolStatusDTO:
    return CliToolStatusDTO(
        name=status.name,
        present=status.present,
        logged_in=status.logged_in,
        identity=status.identity,
        error=status.error,
    )


@router.post(
    "/providers/{type_id}/discover",
    response_model=DiscoverResultDTO,
    dependencies=[Depends(require_setup_token)],
)
def provider_discover(type_id: str, req: DiscoverRequest) -> DiscoverResultDTO:
    """Generic stage-driven discovery.

    Dispatches to the registered provider's `discover` hook (see
    `providers/<type>/setup.py`). Stage names + payload keys are
    provider-defined; the SPA already knows the shape per provider via
    its connection components. Failures collapse to `ok=false` with the
    underlying error message so the SPA can fall back to manual entry
    without translating exception types — the same UX the CLI wizard's
    `__custom__` branch offers."""
    hooks = setup_hooks.get(type_id)
    if hooks is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"unknown provider type: {type_id}",
        )
    if hooks.discover is None:
        return DiscoverResultDTO(
            ok=False,
            error=f"provider type '{type_id}' does not expose discovery",
        )
    try:
        items = hooks.discover(req.stage, dict(req.payload))
    except (ProviderError, ValueError) as e:
        return DiscoverResultDTO(ok=False, error=str(e))
    return DiscoverResultDTO(
        ok=True,
        items=[
            DiscoveryItemDTO(value=item.value, label=item.label, extras=dict(item.extras))
            for item in items
        ],
    )


@router.post(
    "/suggest-key",
    response_model=SuggestKeyDTO,
    dependencies=[Depends(require_setup_token)],
)
def suggest_key(req: SuggestKeyRequest) -> SuggestKeyDTO:
    """Suggest a free provider config key (`<type>` or `<type>-<n>`).

    Mirrors `setup_wizard._step_pick_provider` so a re-run from the web
    wizard offers the same default the CLI does. `taken` is supplied by
    the caller so the route doesn't need to re-load config."""
    return SuggestKeyDTO(key=next_sibling_key(req.type, set(req.taken)))


@router.post(
    "/suggest-label",
    response_model=SuggestLabelDTO,
    dependencies=[Depends(require_setup_token)],
)
def suggest_label(req: SuggestLabelRequest) -> SuggestLabelDTO:
    """Suggest a human-readable display name from the provider draft.

    Same logic as `setup_wizard._suggest_display_name` so the CLI and
    web wizard offer identical defaults; falls back to the `type` id
    when nothing useful can be inferred."""
    label = build_label_suggestion(type_id=req.type, config=dict(req.config))
    return SuggestLabelDTO(label=label or req.type)


@router.post(
    "/probe-scope",
    response_model=ProbeScopeDTO,
    dependencies=[Depends(require_setup_token)],
)
def probe_scope(req: ProbeScopeRequest) -> ProbeScopeDTO:
    """Estimate match-count for a draft scope before the user commits.

    Best-effort wrapper over `WorkItemProvider.list_changes_since(...)` —
    returns `count=None` when the provider cannot be reached or the
    config doesn't validate. The SPA falls back to "could not count"
    in that case (same UX as the CLI wizard)."""
    try:
        scope_filter = ScopeFilter(**dict(req.scope))
    except ValidationError as e:
        return ProbeScopeDTO(count=None, error=f"invalid scope: {e}")
    count = count_items_for_scope(req.type, dict(req.config), scope_filter)
    return ProbeScopeDTO(count=count)


def _schedule_restart() -> None:
    """Fire SIGTERM on self after a short delay so the response can flush first.

    The user's `docket serve` process exits and they re-run it with the
    freshly-written config."""

    def _die() -> None:
        time.sleep(0.5)
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Thread(target=_die, daemon=True).start()


__all__ = ["router"]
