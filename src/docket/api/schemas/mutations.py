"""Proposal DTOs and per-mutation request bodies."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from docket.api.schemas.core import CommentDTO, ItemDTO
from docket.core.model import TransitionIntent
from docket.core.mutation import (
    AttachmentUpload,
    CommentAdd,
    DescriptionPatch,
    ItemCreate,
    MemoryDelete,
    MemoryWrite,
    Proposal,
    StateChange,
    kind_of,
    render_diff,
)


class ProposalDTO(BaseModel):
    """Typed proposal exposed to HTTP callers.

    The `kind` discriminator matches the internal `Proposal.kind` strings; the
    remaining fields are flattened enough for a caller to render or preview
    without round-tripping to `render_diff` themselves (though we ship that
    pre-rendered for convenience)."""

    id: str
    kind: Literal[
        "state_change",
        "description_patch",
        "attachment_upload",
        "item_create",
        "comment_add",
        "memory_write",
        "memory_delete",
    ]
    item_id: str | None = None
    diff: str
    details: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_core(cls, p: Proposal) -> ProposalDTO:
        item_id: str | None = None
        details: dict[str, Any] = {}
        match p:
            case StateChange():
                item_id = p.item.id
                details = {"intent": p.intent.value, "current_state": p.item.state.value}
            case DescriptionPatch():
                item_id = p.item.id
                details = {"new_description_md": p.new_md}
            case AttachmentUpload():
                item_id = p.item.id
                details = {
                    "filename": p.filename,
                    "content_type": p.content_type,
                    "size_bytes": len(p.content),
                }
            case ItemCreate():
                details = {
                    "kind": p.item_kind.value,
                    "title": p.fields.title,
                    "parent_id": p.fields.parent_id,
                    "assignee": p.fields.assignee,
                    "tags": list(p.fields.tags),
                    "description_md": p.fields.description_md,
                }
            case CommentAdd():
                item_id = p.item.id
                details = {"body_md": p.body_md}
            case MemoryWrite():
                details = {
                    "project_id": p.project_id,
                    "title": p.title,
                    "body_md": p.body_md,
                    "tags": list(p.tags),
                    "memory_id": p.memory_id,
                }
            case MemoryDelete():
                details = {"project_id": p.project_id, "memory_id": p.memory_id}
            case _:
                raise TypeError(f"unknown proposal type: {type(p)!r}")
        return cls(id=p.id, kind=kind_of(p), item_id=item_id, diff=render_diff(p), details=details)


class ProposeTransitionRequest(BaseModel):
    intent: TransitionIntent


class ProposeDescriptionRequest(BaseModel):
    new_description_md: str


class ProposeAttachmentRequest(BaseModel):
    filename: str
    content_base64: str
    content_type: str = "text/markdown; charset=utf-8"


class ProposeCommentRequest(BaseModel):
    body_md: str


class MutationConfirmedDTO(BaseModel):
    proposal_id: str
    dry_run: bool
    item: ItemDTO | None = None
    attachment_url: str | None = None
    comment: CommentDTO | None = None
