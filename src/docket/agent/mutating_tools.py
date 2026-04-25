"""Agent-facing write tools.

These tools do NOT mutate the provider directly. Each call:
  1. Builds a typed `Proposal` via `mutation_service.propose_*`.
  2. Stages it in a `ProposalStore` keyed by proposal id.
  3. Returns a JSON payload containing the proposal id, a short human diff,
     and a status of `pending_confirmation`.

The UI picks up the pending proposal, shows it to the user, and either
confirms (→ `mutation_service.confirm`) or discards it. The model sees only
"pending_confirmation" and must not assume the change took effect.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any

from docket.agent._helpers import arg_error, required_str, str_list
from docket.agent.tools import ToolRegistry
from docket.agent.transcript import filename_for, next_version, render_markdown
from docket.core.model import CreateFields, ItemKind, TransitionIntent
from docket.core.mutation import (
    AttachmentUpload,
    CommentAdd,
    DescriptionPatch,
    ItemCreate,
    StateChange,
    pending_payload,
)
from docket.core.redaction import redact_secrets
from docket.core.services import mutation_service
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider
from docket.storage.repos import conversation_repo, item_repo, message_repo, search_repo

_DUPLICATE_LIMIT = 5


def _find_duplicates(
    conn: sqlite3.Connection, title: str, *, provider_key: str = ""
) -> list[dict[str, str]]:
    """Return up to _DUPLICATE_LIMIT cached items whose title/description/comments
    match *any* word in `title`, best-match first. Empty list if nothing
    plausible exists. Uses OR-matching so "Login redesign" catches an existing
    "Login" item that the tight AND-match would miss."""
    ids = search_repo.search_similar(conn, title, provider_key=provider_key)[:_DUPLICATE_LIMIT]
    out: list[dict[str, str]] = []
    for iid in ids:
        item = item_repo.get_item(conn, iid, provider_key=provider_key)
        if item is None:
            continue
        out.append({"id": item.id, "title": item.title, "state": item.state.value})
    return out


def register_mutating_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    store: ProposalStore,
    active_item: Callable[[], str | None],
    provider: WorkItemProvider,
    provider_key: str = "",
) -> None:
    """Register write tools.

    `active_item` returns the id of the currently-focused item — used by
    `attach_transcript` so the model doesn't need to pass it.

    `provider` lets propose_* tools fall back to a live provider fetch when
    the target item isn't in the local cache (parents and cross-scope items
    routinely miss the sync window).
    """

    def propose_transition(args: dict[str, Any]) -> str:
        try:
            item_id = required_str(args, "id")
            intent_raw = required_str(args, "intent")
        except ValueError as e:
            return arg_error(str(e))
        try:
            intent = TransitionIntent(intent_raw)
        except ValueError:
            allowed = [i.value for i in TransitionIntent]
            return json.dumps({"error": f"unknown intent '{intent_raw}'", "allowed": allowed})
        try:
            item = mutation_service.require_cached_item(
                conn, item_id, provider_key=provider_key, provider=provider
            )
        except KeyError as e:
            return arg_error(str(e))
        proposal = StateChange(item=item, intent=intent)
        store.add(proposal)
        return pending_payload(proposal)

    def propose_description_patch(args: dict[str, Any]) -> str:
        try:
            item_id = required_str(args, "id")
        except ValueError as e:
            return arg_error(str(e))
        new_md = args.get("new_description_md")
        if not isinstance(new_md, str):
            return arg_error("new_description_md is required")
        try:
            item = mutation_service.require_cached_item(
                conn, item_id, provider_key=provider_key, provider=provider
            )
        except KeyError as e:
            return arg_error(str(e))
        proposal = DescriptionPatch(item=item, new_md=new_md)
        store.add(proposal)
        return pending_payload(proposal)

    def propose_new_item(args: dict[str, Any]) -> str:
        try:
            kind_raw = required_str(args, "kind")
            title = required_str(args, "title")
            tags = str_list(args, "tags")
        except ValueError as e:
            return arg_error(str(e))
        try:
            kind = ItemKind(kind_raw)
        except ValueError:
            allowed = [k.value for k in ItemKind]
            return json.dumps({"error": f"unknown kind '{kind_raw}'", "allowed": allowed})
        fields = CreateFields(
            title=title,
            description_md=str(args.get("description_md", "") or ""),
            parent_id=args.get("parent_id") or None,
            assignee=args.get("assignee") or None,
            tags=tags,
        )
        proposal = ItemCreate(item_kind=kind, fields=fields)
        store.add(proposal)
        # Surface potential duplicates so the agent can reconsider — still
        # stage the proposal so the human has final say in the diff modal.
        similar = _find_duplicates(conn, title, provider_key=provider_key)
        extra = {"similar": similar} if similar else None
        return pending_payload(proposal, extra=extra)

    def propose_comment(args: dict[str, Any]) -> str:
        try:
            item_id = required_str(args, "id")
        except ValueError as e:
            return arg_error(str(e))
        body_md = args.get("body_md")
        if not isinstance(body_md, str) or not body_md.strip():
            return arg_error("non-empty body_md is required")
        try:
            item = mutation_service.require_cached_item(
                conn, item_id, provider_key=provider_key, provider=provider
            )
        except KeyError as e:
            return arg_error(str(e))
        proposal = CommentAdd(item=item, body_md=body_md)
        store.add(proposal)
        return pending_payload(proposal)

    def attach_transcript(args: dict[str, Any]) -> str:
        item_id = str(args.get("id") or active_item() or "").strip()
        if not item_id:
            return arg_error("no item in focus and none provided")
        convo = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
        if convo is None:
            return arg_error(f"no active conversation for {item_id}")
        messages = message_repo.list_for_conversation(conn, convo.id)
        if not messages:
            return arg_error("conversation is empty")
        try:
            item = mutation_service.require_cached_item(
                conn, item_id, provider_key=provider_key, provider=provider
            )
        except KeyError as e:
            return arg_error(str(e))
        version = next_version(conn, item_id, provider_key=provider_key)
        filename = filename_for(version)
        md = render_markdown(
            item_id=item_id,
            item_title=item.title,
            messages=messages,
            started_at=convo.started_at,
        )
        # Strip recognizable secrets before the bytes leave the machine — the
        # transcript is about to be uploaded to the provider as an attachment.
        md = redact_secrets(md)
        proposal = AttachmentUpload(
            item=item,
            filename=filename,
            content=md.encode("utf-8"),
            content_type="text/markdown; charset=utf-8",
        )
        store.add(proposal)
        return pending_payload(proposal)

    registry.register(
        name="propose_transition",
        description=(
            "Stage a state transition for user confirmation. Returns a proposal id and diff; "
            "the change only takes effect after the human approves it in the UI."
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Work item id"},
                "intent": {
                    "type": "string",
                    "enum": [i.value for i in TransitionIntent],
                },
            },
            "required": ["id", "intent"],
        },
        handler=propose_transition,
    )
    registry.register(
        name="propose_description_patch",
        description=(
            "Stage a description edit for user confirmation. Returns a unified diff; "
            "not applied until confirmed."
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "new_description_md": {"type": "string"},
            },
            "required": ["id", "new_description_md"],
        },
        handler=propose_description_patch,
    )
    registry.register(
        name="propose_new_item",
        description="Stage a new work-item creation for user confirmation.",
        parameters={
            "type": "object",
            "properties": {
                "kind": {"type": "string", "enum": [k.value for k in ItemKind]},
                "title": {"type": "string"},
                "description_md": {"type": "string"},
                "parent_id": {"type": ["string", "null"]},
                "assignee": {"type": ["string", "null"]},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["kind", "title"],
        },
        handler=propose_new_item,
    )
    registry.register(
        name="attach_transcript",
        description=(
            "Render the current conversation as Markdown and stage it for upload as "
            "`convo-NNN.md`. User confirmation required."
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Item id; defaults to the currently focused item.",
                },
            },
        },
        handler=attach_transcript,
    )
    registry.register(
        name="propose_comment",
        description=(
            "Stage a new comment on a work item for user confirmation. Returns a preview; "
            "the comment is only posted after the human approves it in the UI."
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Work item id"},
                "body_md": {
                    "type": "string",
                    "description": "Comment body in Markdown.",
                },
            },
            "required": ["id", "body_md"],
        },
        handler=propose_comment,
    )


__all__ = ["register_mutating_tools"]
