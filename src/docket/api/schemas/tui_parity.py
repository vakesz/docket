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
