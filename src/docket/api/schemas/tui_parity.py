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

    `id` is the stable composite key used everywhere internally; UIs render
    `name`. `active` is true when this is the currently-active project for
    the runtime. `description` is human-edited."""

    id: str
    name: str
    description: str = ""
    provider_key: str
    scope_key: str
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
