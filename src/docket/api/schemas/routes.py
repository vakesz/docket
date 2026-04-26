"""DTOs shared by the non-mutation HTTP routes: pins, suggestions, prompts, scopes,
providers, settings, sync, sources, memory, MCP. These started as a TUI-parity
set but the HTTP surface is now the canonical consumer, so the schema lives
alongside the other route schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from docket.config.models import FacetConfig, ProjectEntry, ProjectViewConfig, SavedView
from docket.core.model import MemoryEntry, Source, StateBucketLiteral, TransitionIntent


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


class SavedViewDTO(BaseModel):
    """One saved view exposed over HTTP.

    `assignees` matches `Item.assignee` with OR semantics; `@me` is the
    sentinel resolved to the provider's `current_user_identity`. `axes`
    is keyed by `ProviderSpec.scope_axes[*].key` and each value is a list
    so multi-select is first-class. `state_bucket` toggles the open/done
    grouping for this view; the chip-bar can override it in-session."""

    name: str
    assignees: list[str] = Field(default_factory=list)
    axes: dict[str, list[str]] = Field(default_factory=dict)
    state_bucket: StateBucketLiteral = "open"
    active: bool = False

    @classmethod
    def from_core(cls, name: str, view: SavedView, *, active: bool) -> SavedViewDTO:
        return cls(
            name=name,
            assignees=list(view.assignees),
            axes={k: list(v) for k, v in view.axes.items()},
            state_bucket=view.state_bucket,
            active=active,
        )


class ViewSwitchRequest(BaseModel):
    """Activate one of the provider's saved views by name."""

    name: str


class SavedViewWriteRequest(BaseModel):
    """Body for create/update of a saved view.

    The view name is the URL path param (`PUT /providers/{key}/views/{name}`).
    Empty `assignees`/`axes` mean "no narrowing on that facet"."""

    assignees: list[str] = Field(default_factory=list)
    axes: dict[str, list[str]] = Field(default_factory=dict)
    state_bucket: StateBucketLiteral = "open"


class ViewOverrideDTO(BaseModel):
    """The active session-level chip-bar override for the current provider.

    `present=False` means no override is in effect; `view` then mirrors the
    saved view. `present=True` means the chip bar has unsaved selections
    different from the saved view; the user can clear them with
    `DELETE /api/runtime/view-overrides`."""

    present: bool
    view: SavedViewDTO


class ViewOverridePatch(BaseModel):
    """Body for `PATCH /api/runtime/view-overrides`.

    Replaces this session's chip-bar override outright. Sending an empty
    payload (defaults) parks the user on "open + no narrowing" — same as
    if they cleared every chip. To remove the override entirely (so the
    saved view shows through), call `DELETE` instead."""

    assignees: list[str] = Field(default_factory=list)
    axes: dict[str, list[str]] = Field(default_factory=dict)
    state_bucket: StateBucketLiteral = "open"


class FacetOptionDTO(BaseModel):
    value: str
    count: int


class FacetDTO(BaseModel):
    """One chip on the view bar (assignee, state, tags, or a provider axis).

    `options` is the (capped) top-N values + counts; `total_options` is the
    full unique-value count before the cap so the SPA can render `+N more`."""

    key: str
    label: str
    options: list[FacetOptionDTO] = Field(default_factory=list)
    total_options: int = 0


class FacetConfigDTO(BaseModel):
    visible: bool = True
    max_options: int = 4

    @classmethod
    def from_core(cls, cfg: FacetConfig) -> FacetConfigDTO:
        return cls(visible=cfg.visible, max_options=cfg.max_options)


class ProjectViewConfigDTO(BaseModel):
    """Per-project facet visibility + caps for the view bar."""

    facets: dict[str, FacetConfigDTO] = Field(default_factory=dict)

    @classmethod
    def from_core(cls, cfg: ProjectViewConfig) -> ProjectViewConfigDTO:
        return cls(facets={k: FacetConfigDTO.from_core(v) for k, v in cfg.facets.items()})


class ProjectViewConfigPatch(BaseModel):
    """PATCH body for `/api/projects/{key}/view-config`.

    Each facet entry replaces the existing one; missing facets are left
    untouched. To restore defaults for a facet, omit it."""

    facets: dict[str, FacetConfigDTO] = Field(default_factory=dict)


class ProviderDTO(BaseModel):
    key: str
    type: str
    display_name: str
    views: list[str] = Field(default_factory=list)
    active_view: str = ""
    active: bool = False
    supported_kinds: list[str] = Field(default_factory=list)


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

    @classmethod
    def from_core(cls, project_id: str, entry: ProjectEntry, *, active_id: str) -> ProjectDTO:
        return cls(
            id=project_id,
            name=entry.name,
            description=entry.description,
            provider_key=entry.provider_key,
            active=(project_id == active_id),
            archived=entry.archived,
        )


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

    Stores the key in the OS keyring (macOS Keychain / Windows Credential
    Manager / freedesktop Secret Service) and writes a non-secret hint into
    `[llm.key_hint]` in `config.toml` so the UI can render a preview. Leaving
    `api_key` empty here is rejected — use `DELETE /api/settings/llm-key`
    to clear. The live LLM client still holds the previous key; the response
    sets `requires_restart=True` whenever the value actually changed."""

    api_key: str


class SettingsLlmKeyDTO(BaseModel):
    """Response for set/clear of the LLM API key.

    `configured` reflects whether a key is currently stored. The hint comes
    along on `GET /api/settings` via `config.llm.key_hint`, so we don't
    duplicate it here — clients merge the updated config separately."""

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
    `active_provider` to the new key. `view` provides the initial saved
    view (named `default`); omit for an empty default view."""

    key: str
    type: str
    display_name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    view: dict[str, Any] = Field(default_factory=dict)
    make_active: bool = False


class SettingsProviderUpdateRequest(BaseModel):
    """Update an existing provider's display_name and config.

    The provider `key` (path param) and `type` are immutable — to change them
    the caller removes and re-adds. `view` is left untouched if omitted, so
    in-flight view edits aren't clobbered by a credentials-only update."""

    display_name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)
    view: dict[str, Any] | None = None


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

    @classmethod
    def from_core(cls, entry: MemoryEntry) -> MemoryDTO:
        return cls(
            id=entry.id,
            project_id=entry.project_id,
            title=entry.title,
            body_md=entry.body_md,
            tags=list(entry.tags),
            source=entry.source,
            created_at=entry.created_at,
            updated_at=entry.updated_at,
        )


class MemoryListDTO(BaseModel):
    project_id: str
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

    @classmethod
    def from_core(cls, entry: Source) -> SourceDTO:
        return cls(
            id=entry.id,
            project_id=entry.project_id,
            title=entry.title,
            body_md=entry.body_md,
            kind=entry.kind,
            uri=entry.uri,
            tags=list(entry.tags),
            created_at=entry.created_at,
            updated_at=entry.updated_at,
        )


class SourceListDTO(BaseModel):
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
    user-facing `name` (the dict key in `ProjectEntry.mcp`). `command/args/env`
    apply to `transport=stdio`; `url/headers` apply to `transport=http` or
    `transport=sse`. The unused half is left empty per `mcp_service.validate_entry`."""

    project_id: str
    name: str
    transport: str = "stdio"
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
    startup_timeout_seconds: float = 10.0


class MCPServerListDTO(BaseModel):
    project_id: str
    entries: list[MCPServerDTO] = Field(default_factory=list)


class MCPServerUpdateRequest(BaseModel):
    """PATCH body. Only fields you set are written; others are left alone.

    Pass `args=[]`, `env={}`, or `headers={}` to explicitly clear those
    collections."""

    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    url: str | None = None
    headers: dict[str, str] | None = None
    transport: str | None = None
    enabled: bool | None = None
    startup_timeout_seconds: float | None = None


class MCPRuntimeServerDTO(BaseModel):
    """One server in the live MCP fleet for the active project.

    `connected=True` means the manager currently holds a started client;
    `connected=False` plus a `last_error` means the last bind attempt
    failed (e.g. handshake timeout, missing remote URL). `tools` lists the
    fully-qualified `mcp__<name>__<tool>` ids registered with the agent."""

    name: str
    transport: str
    connected: bool
    tools: list[str] = Field(default_factory=list)
    started_at: datetime | None = None
    last_error: str | None = None


class MCPRuntimeDTO(BaseModel):
    """Snapshot of the live MCP fleet at request time.

    `active_project_id` is the project the manager is currently bound to,
    not necessarily the URL's `project_id` — the runtime is per-process,
    so a request that asks about an inactive project gets the configured
    list (via the regular CRUD routes) but no live state here."""

    project_id: str
    active_project_id: str | None = None
    servers: list[MCPRuntimeServerDTO] = Field(default_factory=list)


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
    """One env-var slot a preset asks the caller to supply.

    Every slot is required — there is no optional knob today. Surfaces
    should refuse to apply the preset until every name has a value."""

    name: str
    description: str
    placeholder: str = ""


class MCPPresetDTO(BaseModel):
    """A frozen recipe for a known MCP server.

    Surfaces turn this into a real `MCPServerDTO` by calling
    `POST /mcp/presets/{id}/apply` with the env values filled in. All
    bundled presets are stdio; the transport isn't surfaced here."""

    id: str
    label: str
    description: str
    default_name: str
    command: str
    args: list[str] = Field(default_factory=list)
    env: list[MCPPresetEnvDTO] = Field(default_factory=list)
    docs_url: str = ""
    startup_timeout_seconds: float = 15.0


class MCPPresetListDTO(BaseModel):
    presets: list[MCPPresetDTO] = Field(default_factory=list)


class MCPPresetApplyRequest(BaseModel):
    """Body for `POST /projects/{id}/mcp/presets/{preset_id}/apply`.

    `name` overrides the preset's own default server name; leave unset to use
    the preset default. `env` must contain values for every env var the
    preset declares."""

    name: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    enabled: bool = True
