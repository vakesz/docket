"""Core item / comment / attachment / chat / conversation / status DTOs."""

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
    author: str | None = None
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
            author=item.author,
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


class ChatRoleDTO(BaseModel):
    """Mirrors the internal ChatMessage but flattens tool_calls so JSON
    consumers don't need to chase a union."""

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


class StatusDTO(BaseModel):
    provider_key: str
    provider_display: str
    scope_key: str
    read_only: bool
    chat_enabled: bool
    last_sync_at: datetime | None = None
    offline: bool = False
    pending_proposals: int = 0
