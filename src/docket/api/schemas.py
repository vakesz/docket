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
    "ProposalDTO",
    "ProposeAttachmentRequest",
    "ProposeDescriptionRequest",
    "ProposeTransitionRequest",
    "SendMessageRequest",
    "UsageDTO",
]
