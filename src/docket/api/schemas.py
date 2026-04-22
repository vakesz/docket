"""Pydantic DTOs exposed over the HTTP surface.

Converted from the internal dataclasses so the HTTP contract is decoupled
from on-disk / in-memory representations. Only fields useful to a headless
API caller are exposed — `provider_raw` for example is deliberately omitted
since it leaks ADO-specific shape."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from docket.core.model import (
    Attachment,
    Comment,
    Conversation,
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    TransitionIntent,
)
from docket.core.mutation import (
    AttachmentUpload,
    DescriptionPatch,
    ItemCreate,
    Proposal,
    StateChange,
    render_diff,
)


class AttachmentDTO(BaseModel):
    filename: str
    url: str | None = None

    @classmethod
    def from_core(cls, a: Attachment) -> AttachmentDTO:
        return cls(filename=a.filename, url=a.url)


class ItemDTO(BaseModel):
    id: str
    kind: ItemKind
    title: str
    description_md: str
    state: ItemState
    assignee: str | None = None
    parent_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    updated_at: datetime | None = None
    url: str | None = None
    attachments: list[AttachmentDTO] = Field(default_factory=list)

    @classmethod
    def from_core(cls, item: Item) -> ItemDTO:
        return cls(
            id=item.id,
            kind=item.kind,
            title=item.title,
            description_md=item.description_md,
            state=item.state,
            assignee=item.assignee,
            parent_id=item.parent_id,
            tags=list(item.tags),
            updated_at=item.updated_at,
            url=item.url,
            attachments=[AttachmentDTO.from_core(a) for a in item.attachments],
        )


class CommentDTO(BaseModel):
    id: str
    item_id: str
    author: str
    body_md: str
    created_at: datetime

    @classmethod
    def from_core(cls, c: Comment) -> CommentDTO:
        return cls(
            id=c.id,
            item_id=c.item_id,
            author=c.author,
            body_md=c.body_md,
            created_at=c.created_at,
        )


class CreateItemRequest(BaseModel):
    kind: ItemKind
    title: str
    description_md: str = ""
    parent_id: str | None = None
    assignee: str | None = None
    tags: list[str] = Field(default_factory=list)

    def to_create_fields(self) -> CreateFields:
        return CreateFields(
            title=self.title,
            description_md=self.description_md,
            parent_id=self.parent_id,
            assignee=self.assignee,
            tags=list(self.tags),
        )


class ProposalDTO(BaseModel):
    """Typed proposal exposed to HTTP callers.

    The `kind` discriminator matches the internal `Proposal.kind` strings; the
    remaining fields are flattened enough for a caller to render or preview
    without round-tripping to `render_diff` themselves (though we ship that
    pre-rendered for convenience)."""

    id: str
    kind: Literal["state_change", "description_patch", "attachment_upload", "item_create"]
    item_id: str | None = None
    diff: str
    details: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_core(cls, p: Proposal) -> ProposalDTO:
        item_id: str | None
        details: dict[str, Any] = {}
        if isinstance(p, StateChange):
            item_id = p.item.id
            details = {"intent": p.intent.value, "current_state": p.item.state.value}
        elif isinstance(p, DescriptionPatch):
            item_id = p.item.id
            details = {"new_description_md": p.new_md}
        elif isinstance(p, AttachmentUpload):
            item_id = p.item.id
            details = {
                "filename": p.filename,
                "content_type": p.content_type,
                "size_bytes": len(p.content),
            }
        elif isinstance(p, ItemCreate):
            item_id = None
            details = {
                "kind": p.item_kind.value,
                "title": p.fields.title,
                "parent_id": p.fields.parent_id,
                "assignee": p.fields.assignee,
                "tags": list(p.fields.tags),
                "description_md": p.fields.description_md,
            }
        else:  # pragma: no cover - exhaustive
            raise TypeError(f"unknown proposal type: {type(p)!r}")
        return cls(id=p.id, kind=p.kind, item_id=item_id, diff=render_diff(p), details=details)


class ProposeTransitionRequest(BaseModel):
    intent: TransitionIntent


class ProposeDescriptionRequest(BaseModel):
    new_description_md: str


class ProposeAttachmentRequest(BaseModel):
    filename: str
    content_base64: str
    content_type: str = "text/markdown; charset=utf-8"


class MutationConfirmedDTO(BaseModel):
    proposal_id: str
    dry_run: bool
    item: ItemDTO | None = None
    attachment_url: str | None = None


class ChatRoleDTO(BaseModel):
    """We deliberately mirror the internal ChatMessage but flatten tool_calls
    so JSON consumers don't need to chase a union."""

    role: str
    content: str = ""
    tool_calls: list[dict[str, Any]] = Field(default_factory=list)
    tool_call_id: str | None = None
    name: str | None = None


class ConversationDTO(BaseModel):
    id: str
    item_id: str
    started_at: datetime
    archived_at: datetime | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_cents: int = 0

    @classmethod
    def from_core(cls, c: Conversation) -> ConversationDTO:
        return cls(
            id=c.id,
            item_id=c.item_id,
            started_at=c.started_at,
            archived_at=c.archived_at,
            tokens_in=c.tokens_in,
            tokens_out=c.tokens_out,
            cost_cents=c.cost_cents,
        )


class ConversationHistoryDTO(BaseModel):
    conversation: ConversationDTO | None
    messages: list[ChatRoleDTO]


class SendMessageRequest(BaseModel):
    text: str


class UsageDTO(BaseModel):
    tokens_in: int = 0
    tokens_out: int = 0
    cached_tokens_in: int = 0


class HealthDTO(BaseModel):
    status: Literal["ok"] = "ok"


# -- Phase 1 additions (TUI-parity endpoints) ---------------------------------


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


class StatusDTO(BaseModel):
    provider_key: str
    provider_display: str
    scope_key: str
    read_only: bool
    chat_enabled: bool
    last_sync_at: datetime | None = None
    offline: bool = False
    pending_proposals: int = 0


# -- Setup (first-time-wizard over HTTP) -------------------------------------


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


class SetupFoundryEntry(BaseModel):
    endpoint: str
    api_key: str
    deployment: str = "gpt-5"
    api_version: str | None = None


class SetupCompleteRequest(BaseModel):
    providers: dict[str, SetupProviderEntry]
    active_provider: str
    foundry: SetupFoundryEntry | None = None
    http_bind: str = "0.0.0.0"
    http_port: int = 8765
    http_token: str = ""
    telemetry_enabled: bool = True
    run_initial_sync: bool = True


class SetupCompleteDTO(BaseModel):
    ok: bool
    config_path: str
    http_token: str
    restart_required: bool = True
    initial_sync: SyncSummaryDTO | None = None


__all__ = [
    "AttachmentDTO",
    "ChatRoleDTO",
    "CommentDTO",
    "ConversationDTO",
    "ConversationHistoryDTO",
    "CreateItemRequest",
    "HealthDTO",
    "ItemDTO",
    "MutationConfirmedDTO",
    "PinnedStatusDTO",
    "PromptDTO",
    "PromptSummaryDTO",
    "PromptUpdateRequest",
    "ProposalDTO",
    "ProposeAttachmentRequest",
    "ProposeDescriptionRequest",
    "ProposeTransitionRequest",
    "ProviderDTO",
    "ProviderSwitchRequest",
    "ScopeDTO",
    "ScopeSwitchRequest",
    "SendMessageRequest",
    "SettingsDTO",
    "SettingsPatchRequest",
    "SettingsUpdatedDTO",
    "SetupCompleteDTO",
    "SetupCompleteRequest",
    "SetupFoundryEntry",
    "SetupProviderEntry",
    "SetupProviderFieldDTO",
    "SetupProviderTypeDTO",
    "SetupStatusDTO",
    "SetupTestLlmRequest",
    "SetupTestProviderRequest",
    "SetupTestResultDTO",
    "StatusDTO",
    "SuggestionDTO",
    "SuggestionStageRequest",
    "SyncSummaryDTO",
    "UsageDTO",
]
