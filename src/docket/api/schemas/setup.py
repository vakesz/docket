"""First-time-wizard-over-HTTP DTOs."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from docket.api.schemas.routes import SyncSummaryDTO
from docket.config.models import TelemetryLevel


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


class SetupProviderScopeAxisDTO(BaseModel):
    """One provider-declared narrowing axis the visual filter exposes.

    `key` is the wire identifier persisted under `ScopeFilter.axes`;
    `label` is rendered to humans. `discovery_stage`, when present, names
    the `discover` stage the SPA can hit to populate a datalist of
    candidate values; the SPA falls back to a free-form input when it's
    `None`. Assignee is intentionally not modeled here — it's a separate
    first-class field on every scope."""

    key: str
    label: str
    discovery_stage: str | None = None


class SetupProviderTypeDTO(BaseModel):
    id: str
    display: str
    requires_cli: list[str] = Field(default_factory=list)
    fields: list[SetupProviderFieldDTO] = Field(default_factory=list)
    scope_axes: list[SetupProviderScopeAxisDTO] = Field(default_factory=list)


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
    price_input_per_1m: float | None = None
    price_output_per_1m: float | None = None


class SetupCompleteRequest(BaseModel):
    providers: dict[str, SetupProviderEntry]
    active_provider: str
    llm: SetupLlmEntry | None = None
    http_bind: str = "0.0.0.0"
    http_port: int = 8765
    http_token: str = ""
    telemetry_enabled: bool = True
    telemetry_level: TelemetryLevel = TelemetryLevel.DEBUG
    run_initial_sync: bool = True


class SetupCompleteDTO(BaseModel):
    ok: bool
    config_path: str
    http_token: str
    restart_required: bool = True
    initial_sync: SyncSummaryDTO | None = None


class CliToolStatusDTO(BaseModel):
    """One CLI dependency's session status — `gh` or `az`.

    Mirrors the wizard's terminal probe: is the binary on PATH, does it
    have an active session, and what identity is signed in. The frontend
    uses this to render the same retry-after-`gh auth login` UX the CLI
    has, without trying to start the login itself."""

    name: str
    present: bool
    logged_in: bool
    identity: str = ""
    error: str = ""


class GithubHostDTO(BaseModel):
    hostname: str
    api_base_url: str


class CliStatusDTO(BaseModel):
    az: CliToolStatusDTO
    gh: CliToolStatusDTO
    gh_hosts: list[GithubHostDTO] = Field(default_factory=list)
    keyring_available: bool = False
    keyring_error: str = ""


class DiscoverRequest(BaseModel):
    """Stage-driven discovery for the SPA wizard.

    `stage` is provider-specific (`"orgs"`, `"projects"`, `"repos"`, …);
    `payload` carries any context the stage needs (e.g. `{"org": "..."}`
    for ADO `projects`, or `{"host": "..."}` for GitHub `repos`). The
    backend dispatches to the registered provider's `discover` hook so
    new providers participate without API churn."""

    stage: str
    payload: dict[str, str] = Field(default_factory=dict)


class DiscoveryItemDTO(BaseModel):
    """One row of a discovery result.

    `value` is what the picker should persist (org URL, repo full-name,
    team name); `label` is what to render. `extras` is provider-specific
    metadata — the GitHub host stage uses it to surface `api_base_url`
    so the SPA can map a hostname to its API endpoint without a second
    round-trip."""

    value: str
    label: str
    extras: dict[str, str] = Field(default_factory=dict)


class DiscoverResultDTO(BaseModel):
    ok: bool
    error: str = ""
    items: list[DiscoveryItemDTO] = Field(default_factory=list)


class SuggestKeyRequest(BaseModel):
    type: str
    taken: list[str] = Field(default_factory=list)


class SuggestKeyDTO(BaseModel):
    key: str


class SuggestLabelRequest(BaseModel):
    type: str
    config: dict[str, Any] = Field(default_factory=dict)


class SuggestLabelDTO(BaseModel):
    label: str


class ProbeScopeRequest(BaseModel):
    """Estimate match-count for a scope draft, before the user commits.

    Same UX as the CLI wizard's "→ N item(s) match this scope" preview.
    Returns `count=None` when the provider can't be reached or doesn't
    support cheap counting — callers fall back to "could not count"."""

    type: str
    config: dict[str, Any] = Field(default_factory=dict)
    scope: dict[str, Any] = Field(default_factory=dict)


class ProbeScopeDTO(BaseModel):
    count: int | None = None
    error: str = ""
