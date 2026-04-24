"""TUI-parity DTOs: pins, suggestions, prompts, scopes, providers, settings, sync."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from docket.core.model import TransitionIntent


class PinnedStatusDTO(BaseModel):
    item_id: str
    pinned: bool


class SuggestionDTO(BaseModel):
    item_id: str
    intent: TransitionIntent
    description_patch_md: str = ""
    open_questions: list[str] = Field(default_factory=list)


class SuggestionStageRequest(BaseModel):
    intent: TransitionIntent
    description_patch_md: str = ""


class PromptSummaryDTO(BaseModel):
    key: str
    label: str
    filename: str
    customized: bool


class PromptDTO(BaseModel):
    key: str
    label: str
    filename: str
    content_md: str
    customized: bool


class PromptUpdateRequest(BaseModel):
    content_md: str


class ScopeDTO(BaseModel):
    name: str
    team: str = ""
    area_path: str = ""
    iteration_path: str = ""
    assignee: str = "@me"
    active: bool = False


class ScopeSwitchRequest(BaseModel):
    name: str


class ProviderDTO(BaseModel):
    key: str
    type: str
    display_name: str
    scopes: list[str] = Field(default_factory=list)
    active_scope: str = ""
    active: bool = False


class ProviderSwitchRequest(BaseModel):
    key: str


class ProjectDTO(BaseModel):
    """Project surface for the HTTP API.

    `id` is the provider key used everywhere internally; UIs render `name`.
    `active` is true when this is the currently-active project for the
    runtime. `description` is human-edited."""

    id: str
    name: str
    description: str = ""
    provider_key: str
    active: bool = False
    archived: bool = False


class ProjectUpdateRequest(BaseModel):
    """PATCH body. Only fields you set are written; others are left alone."""

    name: str | None = None
    description: str | None = None
    archived: bool | None = None


class SettingsDTO(BaseModel):
    """Current config.toml, with secrets masked.

    Shape mirrors `Config.model_dump()` exactly so the frontend can round-trip
    a deep-partial via `PATCH /settings`. The only transformation is that
    `http.token` comes back as `••••••••XXXX` (last four chars) when present."""

    config: dict[str, Any] = Field(default_factory=dict)


class SettingsPatchRequest(BaseModel):
    """Deep-partial merge onto the current Config.

    The frontend sends only the keys it wants to update. Values of `None` are
    treated as 'delete this key' — but in practice the frontend never needs to
    delete, so it's a Pydantic default we inherit from `exclude_unset`."""

    patch: dict[str, Any] = Field(default_factory=dict)


class SettingsUpdatedDTO(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)
    requires_restart: list[str] = Field(default_factory=list)


class SettingsLlmKeyRequest(BaseModel):
    """Rotate the LLM API key.

    Persists to the XDG-managed `.env` file so `docket serve` picks it up on
    next start. Leaving `api_key` empty clears the entry (chat 503s until
    re-set). Triggers a rebind of the live LLM client when possible so the
    change takes effect without restart."""

    api_key: str


class SettingsLlmKeyDTO(BaseModel):
    ok: bool
    configured: bool
    requires_restart: bool = False


class SettingsHttpTokenDTO(BaseModel):
    """Response for HTTP token regeneration.

    The new token is returned once in plain text so the caller can persist
    it. Subsequent `GET /settings` calls return it masked."""

    token: str
    requires_restart: bool = True


class SettingsProviderAddRequest(BaseModel):
    """Add a provider entry to config.toml at runtime.

    Shape mirrors `SetupProviderEntry` but is handled under /settings so
    bootstrap-token gating doesn't apply. `make_active=true` also flips
    `active_provider` to the new key."""

    key: str
    type: str
    display_name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    scope: dict[str, Any] = Field(default_factory=dict)
    make_active: bool = False


class SettingsProviderUpdateRequest(BaseModel):
    """Update an existing provider's display_name and config.

    The provider `key` (path param) and `type` are immutable — to change them
    the caller removes and re-adds. `scope` is left untouched if omitted, so
    in-flight scope edits aren't clobbered by a credentials-only update."""

    display_name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    scope: dict[str, Any] | None = None


class SyncSummaryDTO(BaseModel):
    upserted: int
    archived: int
    watermark: datetime | None = None
    offline: bool = False


# -- memory ------------------------------------------------------------------


class MemoryDTO(BaseModel):
    """One memory entry as exposed over HTTP. Bodies are full markdown —
    list endpoints include them so a frontend can render previews without
    a per-row follow-up call."""

    id: str
    project_id: str
    title: str
    body_md: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "user"
    created_at: datetime | None = None
    updated_at: datetime | None = None


class MemoryListDTO(BaseModel):
    """List response carries the project's memory `revision` so a frontend
    can compare against a cached value and skip re-rendering when nothing
    has changed. The same revision is keyed into the LLM prompt prefix."""

    project_id: str
    revision: int = 0
    entries: list[MemoryDTO] = Field(default_factory=list)


class MemoryCreateRequest(BaseModel):
    title: str
    body_md: str = ""
    tags: list[str] = Field(default_factory=list)


class MemoryUpdateRequest(BaseModel):
    title: str | None = None
    body_md: str | None = None
    tags: list[str] | None = None


# -- sources -----------------------------------------------------------------


class SourceDTO(BaseModel):
    """One source document. Like memory, list endpoints include the body
    so a frontend can render previews in one round-trip."""

    id: str
    project_id: str
    title: str
    body_md: str = ""
    kind: str = ""
    uri: str = ""
    tags: list[str] = Field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


class SourceListDTO(BaseModel):
    """No revision counter: sources are not part of the prompt prefix."""

    project_id: str
    entries: list[SourceDTO] = Field(default_factory=list)


class SourceCreateRequest(BaseModel):
    title: str
    body_md: str = ""
    kind: str = ""
    uri: str = ""
    tags: list[str] = Field(default_factory=list)


class SourceUpdateRequest(BaseModel):
    title: str | None = None
    body_md: str | None = None
    kind: str | None = None
    uri: str | None = None
    tags: list[str] | None = None


# -- mcp ---------------------------------------------------------------------


class MCPToolDTO(BaseModel):
    id: str
    server_name: str
    name: str
    description: str = ""
    input_schema: dict[str, Any] = Field(default_factory=dict)


class MCPServerDTO(BaseModel):
    """One MCP server attached to a project, as exposed over HTTP.

    Mirrors `docket.config.models.MCPServerEntry` plus the project id and the
    user-facing `name` (the dict key in `ProjectEntry.mcp`)."""

    project_id: str
    name: str
    transport: str = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    startup_timeout_seconds: float = 10.0


class MCPServerListDTO(BaseModel):
    project_id: str
    entries: list[MCPServerDTO] = Field(default_factory=list)


class MCPServerCreateRequest(BaseModel):
    name: str
    command: str
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    transport: str = "stdio"
    enabled: bool = True
    startup_timeout_seconds: float = 10.0


class MCPServerUpdateRequest(BaseModel):
    """PATCH body. Only fields you set are written; others are left alone.

    Pass `args=[]` or `env={}` to explicitly clear those collections."""

    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    transport: str | None = None
    enabled: bool | None = None
    startup_timeout_seconds: float | None = None


class MCPServerTestRequest(BaseModel):
    """Draft MCP server config to validate without persisting it."""

    name: str
    command: str
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    transport: str = "stdio"
    enabled: bool = True
    startup_timeout_seconds: float = 10.0


class MCPServerTestResultDTO(BaseModel):
    """Outcome of `POST /projects/{id}/mcp/{name}/test`.

    `tools` is the discovered tool catalog (qualified `mcp__<name>__<tool>`)
    on success; `error` carries a short human-readable reason on failure."""

    name: str
    ok: bool
    tools: list[str] = Field(default_factory=list)
    tool_details: list[MCPToolDTO] = Field(default_factory=list)
    error: str = ""


class MCPPresetEnvDTO(BaseModel):
    """One env-var slot a preset asks the caller to supply."""

    name: str
    description: str
    required: bool = True
    placeholder: str = ""


class MCPPresetDTO(BaseModel):
    """A frozen recipe for a known MCP server.

    Surfaces turn this into a real `MCPServerDTO` by calling
    `POST /mcp/presets/{id}/apply` with the env values filled in."""

    id: str
    label: str
    description: str
    default_name: str
    command: str
    args: list[str] = Field(default_factory=list)
    env: list[MCPPresetEnvDTO] = Field(default_factory=list)
    docs_url: str = ""
    transport: str = "stdio"
    startup_timeout_seconds: float = 15.0


class MCPPresetListDTO(BaseModel):
    presets: list[MCPPresetDTO] = Field(default_factory=list)


class MCPPresetApplyRequest(BaseModel):
    """Body for `POST /projects/{id}/mcp/presets/{preset_id}/apply`.

    `name` overrides the preset's own default server name; leave unset to use
    the preset default. `env` must contain all env vars the preset marks
    `required`."""

    name: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
