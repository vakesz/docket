"""First-time-wizard-over-HTTP DTOs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from docket.api.schemas.tui_parity import SyncSummaryDTO


class SetupStatusDTO(BaseModel):
    """Probe endpoint the frontend hits to pick bootstrap vs normal mode.

    Auth-free — the frontend needs to see this before it can decide whether to
    send the setup token or the real bearer token."""

    needs_setup: bool
    config_path: str
    providers_configured: int = 0
    active_provider: str = ""
    llm_configured: bool = False
    http_configured: bool = False


class SetupProviderFieldDTO(BaseModel):
    """Describes one config field a provider type needs from the wizard."""

    key: str
    label: str
    kind: Literal["string", "url", "secret"] = "string"
    required: bool = True
    placeholder: str = ""
    help: str = ""


class SetupProviderTypeDTO(BaseModel):
    id: str
    display: str
    requires_cli: list[str] = Field(default_factory=list)
    fields: list[SetupProviderFieldDTO] = Field(default_factory=list)


class SetupTestProviderRequest(BaseModel):
    type: str
    config: dict[str, Any] = Field(default_factory=dict)


class SetupTestResultDTO(BaseModel):
    ok: bool
    error: str | None = None


class SetupTestLlmRequest(BaseModel):
    endpoint: str
    api_key: str
    deployment: str = "gpt-5"
    api_version: str | None = None


class SetupProviderEntry(BaseModel):
    type: str
    display_name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    scope: dict[str, Any] = Field(default_factory=dict)


class SetupLlmEntry(BaseModel):
    endpoint: str
    api_key: str
    deployment: str = "gpt-5"
    api_version: str | None = None


class SetupCompleteRequest(BaseModel):
    providers: dict[str, SetupProviderEntry]
    active_provider: str
    llm: SetupLlmEntry | None = None
    http_bind: str = "0.0.0.0"
    http_port: int = 8765
    http_token: str = ""
    telemetry_enabled: bool = True
    telemetry_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = "DEBUG"
    run_initial_sync: bool = True


class SetupCompleteDTO(BaseModel):
    ok: bool
    config_path: str
    http_token: str
    restart_required: bool = True
    initial_sync: SyncSummaryDTO | None = None
