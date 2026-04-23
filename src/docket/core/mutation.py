"""Typed mutation proposals, diff rendering, and confirmation gate.

Every mutation in the system — from the CLI, TUI, HTTP API, or an LLM tool call —
flows through a Proposal object. The Proposal is rendered as a human-readable diff
which the caller shows to the user. Only after explicit confirmation is it executed
against the provider. This is the single architectural gate that keeps
AI-initiated writes safe.
"""

from __future__ import annotations

import difflib
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from docket.core.model import CreateFields, Item, ItemKind, TransitionIntent


def _new_id() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True)
class StateChange:
    kind: Literal["state_change"] = field(default="state_change", init=False)
    item: Item
    intent: TransitionIntent
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class DescriptionPatch:
    kind: Literal["description_patch"] = field(default="description_patch", init=False)
    item: Item
    new_md: str
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class AttachmentUpload:
    kind: Literal["attachment_upload"] = field(default="attachment_upload", init=False)
    item: Item
    filename: str
    content: bytes
    content_type: str = "text/markdown; charset=utf-8"
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class ItemCreate:
    kind: Literal["item_create"] = field(default="item_create", init=False)
    item_kind: ItemKind
    fields: CreateFields
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class CommentAdd:
    kind: Literal["comment_add"] = field(default="comment_add", init=False)
    item: Item
    body_md: str
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class MemoryWrite:
    """Stage a create-or-update of a per-project memory entry.

    `memory_id is None` means create; otherwise update. For updates, the
    `previous_*` fields are populated by `mutation_service.propose_memory_write`
    so `render_diff` can show a real before/after — without them the UI
    would only ever show "what's about to land", which doesn't read like a
    diff for a human reviewer."""

    kind: Literal["memory_write"] = field(default="memory_write", init=False)
    project_id: str = ""
    title: str = ""
    body_md: str = ""
    tags: tuple[str, ...] = ()
    source: str = "agent"
    memory_id: str | None = None
    previous_title: str = ""
    previous_body_md: str = ""
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class MemoryDelete:
    kind: Literal["memory_delete"] = field(default="memory_delete", init=False)
    project_id: str = ""
    memory_id: str = ""
    title: str = ""  # snapshot at propose time so the diff is human-readable
    id: str = field(default_factory=_new_id)


Proposal = (
    StateChange
    | DescriptionPatch
    | AttachmentUpload
    | ItemCreate
    | CommentAdd
    | MemoryWrite
    | MemoryDelete
)


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
    if isinstance(proposal, MemoryWrite):
        action = "update" if proposal.memory_id else "create"
        header = f"memory {action}: {proposal.title}"
        if not proposal.memory_id:
            new_lines = (proposal.body_md or "").splitlines()
            return header + "\n" + "\n".join(f"  + {line}" for line in new_lines[:20])
        old = (proposal.previous_body_md or "").splitlines()
        new = (proposal.body_md or "").splitlines()
        diff = difflib.unified_diff(
            old,
            new,
            fromfile=f"memory:{proposal.memory_id} (current)",
            tofile=f"memory:{proposal.memory_id} (proposed)",
            lineterm="",
        )
        body_diff = "\n".join(diff)
        title_line = ""
        if proposal.previous_title and proposal.previous_title != proposal.title:
            title_line = f"  title: {proposal.previous_title!r} → {proposal.title!r}\n"
        return header + "\n" + title_line + (body_diff or "  (body unchanged)")
    if isinstance(proposal, MemoryDelete):
        suffix = f" — '{proposal.title}'" if proposal.title else ""
        return f"memory delete: {proposal.memory_id}{suffix}"
    raise TypeError(f"unknown proposal type: {type(proposal)!r}")


def pending_payload(proposal: Proposal, *, extra: dict[str, Any] | None = None) -> str:
    """JSON wire format for an agent tool that just staged a Proposal.

    Returned to the LLM so it can surface "pending_confirmation" to the user
    without assuming the change took effect. The UI uses `proposal_id` to
    look the proposal up in `ProposalStore` for the confirm modal."""
    body: dict[str, Any] = {
        "status": "pending_confirmation",
        "proposal_id": proposal.id,
        "kind": proposal.kind,
        "diff": render_diff(proposal),
    }
    if extra:
        body.update(extra)
    return json.dumps(body)
