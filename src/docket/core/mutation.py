"""Typed mutation proposals, diff rendering, and confirmation gate.

Every mutation in the system — from the CLI, TUI, HTTP API, or an LLM tool call —
flows through a Proposal object. The Proposal is rendered as a human-readable diff
which the caller shows to the user. Only after explicit confirmation is it executed
against the provider. This is the single architectural gate that keeps
AI-initiated writes safe.
"""

from __future__ import annotations

import difflib
import uuid
from dataclasses import dataclass, field
from typing import Literal

from docket.core.model import CreateFields, Item, ItemKind, TransitionIntent


@dataclass(frozen=True)
class StateChange:
    kind: Literal["state_change"] = field(default="state_change", init=False)
    item: Item
    intent: TransitionIntent
    id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass(frozen=True)
class DescriptionPatch:
    kind: Literal["description_patch"] = field(default="description_patch", init=False)
    item: Item
    new_md: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass(frozen=True)
class AttachmentUpload:
    kind: Literal["attachment_upload"] = field(default="attachment_upload", init=False)
    item: Item
    filename: str
    content: bytes
    content_type: str = "text/markdown; charset=utf-8"
    id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass(frozen=True)
class ItemCreate:
    kind: Literal["item_create"] = field(default="item_create", init=False)
    item_kind: ItemKind
    fields: CreateFields
    id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass(frozen=True)
class CommentAdd:
    kind: Literal["comment_add"] = field(default="comment_add", init=False)
    item: Item
    body_md: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))


Proposal = StateChange | DescriptionPatch | AttachmentUpload | ItemCreate | CommentAdd


def render_diff(proposal: Proposal) -> str:
    """Human-readable preview used by the CLI/TUI/API confirm step."""
    if isinstance(proposal, StateChange):
        return (
            f"[{proposal.item.id}] {proposal.item.title}\n"
            f"  state: {proposal.item.state.value} ──({proposal.intent.value})──▶ ?\n"
            f"  (exact target state depends on provider mapping)"
        )
    if isinstance(proposal, DescriptionPatch):
        old = (proposal.item.description_md or "").splitlines(keepends=False)
        new = (proposal.new_md or "").splitlines(keepends=False)
        diff = difflib.unified_diff(
            old,
            new,
            fromfile=f"{proposal.item.id}:description (current)",
            tofile=f"{proposal.item.id}:description (proposed)",
            lineterm="",
        )
        body = "\n".join(diff)
        return body or f"[{proposal.item.id}] description unchanged"
    if isinstance(proposal, AttachmentUpload):
        size = len(proposal.content)
        return (
            f"[{proposal.item.id}] upload attachment\n"
            f"  filename: {proposal.filename}\n"
            f"  content-type: {proposal.content_type}\n"
            f"  size: {size} bytes"
        )
    if isinstance(proposal, ItemCreate):
        lines = [
            f"create {proposal.item_kind.value}: {proposal.fields.title}",
        ]
        if proposal.fields.parent_id:
            lines.append(f"  parent: {proposal.fields.parent_id}")
        if proposal.fields.assignee:
            lines.append(f"  assignee: {proposal.fields.assignee}")
        if proposal.fields.tags:
            lines.append(f"  tags: {', '.join(proposal.fields.tags)}")
        if proposal.fields.description_md:
            preview = proposal.fields.description_md[:200]
            if len(proposal.fields.description_md) > 200:
                preview += " …"
            lines.append(f"  description: {preview}")
        return "\n".join(lines)
    if isinstance(proposal, CommentAdd):
        body = proposal.body_md or ""
        header = f"[{proposal.item.id}] add comment"
        if not body.strip():
            return f"{header}\n  (empty)"
        return f"{header}\n" + "\n".join(f"  > {line}" for line in body.splitlines())
    raise TypeError(f"unknown proposal type: {type(proposal)!r}")
