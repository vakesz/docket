"""Agent-facing memory tools.

Read-only tools (`list_memory`, `recall_memory`) query the per-project
`memory` table directly — they're cheap and the model uses them often.

Mutating tools (`propose_memory_write`, `propose_memory_delete`) follow the
same proposal-first pattern as `mutating_tools.py`: build a `Proposal`,
stage it in the `ProposalStore`, return `pending_confirmation`. The actual
write only happens when the user (CLI/TUI/HTTP) calls
`mutation_service.confirm`.

Tool registration order is part of the prompt prefix cache key, so the
registration order here is deliberate and stable: list → recall → write →
delete.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from docket.agent._helpers import (
    DEFAULT_LIST_LIMIT,
    DEFAULT_SEARCH_LIMIT,
    MAX_LIST_LIMIT,
    MAX_SEARCH_LIMIT,
    clamp_limit,
)
from docket.agent.tools import ToolRegistry
from docket.core.mutation import pending_payload
from docket.core.services import mutation_service
from docket.core.services.proposal_store import ProposalStore
from docket.storage.repos import memory_repo


def _entry_summary(entry: Any) -> dict[str, Any]:
    return {
        "id": entry.id,
        "title": entry.title,
        "tags": list(entry.tags),
        "source": entry.source,
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
    }


def register_memory_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    project_id: str,
) -> None:
    """Register `list_memory` and `recall_memory` for the given project.

    The project_id is bound at registration time so the model can't read
    notes from another project by mistake."""

    def list_memory(args: dict[str, Any]) -> str:
        limit = clamp_limit(
            args.get("limit", DEFAULT_LIST_LIMIT), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT
        )
        entries = memory_repo.list_for_project(conn, project_id, limit=limit)
        return json.dumps([_entry_summary(e) for e in entries])

    def recall_memory(args: dict[str, Any]) -> str:
        query = str(args.get("query", "")).strip()
        if not query:
            return json.dumps({"error": "query is required"})
        limit = clamp_limit(
            args.get("limit", DEFAULT_SEARCH_LIMIT), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT
        )
        entries = memory_repo.search(conn, project_id, query, limit=limit)
        return json.dumps(
            [
                {
                    **_entry_summary(e),
                    "body_md": e.body_md,
                }
                for e in entries
            ]
        )

    registry.register(
        name="list_memory",
        description=(
            "List the most-recently-updated project memory entries (titles + tags only). "
            "Use this to see what notes already exist before writing new ones."
        ),
        parameters={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "default": DEFAULT_LIST_LIMIT,
                    "minimum": 1,
                    "maximum": MAX_LIST_LIMIT,
                },
            },
        },
        handler=list_memory,
    )
    registry.register(
        name="recall_memory",
        description=(
            "Full-text search the project's memory for relevant notes. Returns matched "
            "entries (including the full Markdown body) ordered by relevance."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search terms"},
                "limit": {
                    "type": "integer",
                    "default": DEFAULT_SEARCH_LIMIT,
                    "minimum": 1,
                    "maximum": MAX_SEARCH_LIMIT,
                },
            },
            "required": ["query"],
        },
        handler=recall_memory,
    )


def register_memory_mutating_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    store: ProposalStore,
    project_id: str,
) -> None:
    """Register `propose_memory_write` and `propose_memory_delete`.

    Both stage proposals; nothing is persisted until the user confirms via
    `mutation_service.confirm`."""

    def propose_memory_write(args: dict[str, Any]) -> str:
        title = str(args.get("title", "")).strip()
        body_md = args.get("body_md")
        if not title or not isinstance(body_md, str):
            return json.dumps({"error": "title and body_md are required"})
        memory_id_raw = args.get("memory_id")
        memory_id = str(memory_id_raw).strip() if memory_id_raw else None
        tags_raw = args.get("tags") or []
        if not isinstance(tags_raw, list):
            return json.dumps({"error": "tags must be an array of strings"})
        tags = [str(t) for t in tags_raw if isinstance(t, (str, int, float))]
        try:
            proposal = mutation_service.propose_memory_write(
                conn,
                project_id=project_id,
                title=title,
                body_md=body_md,
                tags=tags,
                source="agent",
                memory_id=memory_id,
            )
        except (KeyError, ValueError) as e:
            return json.dumps({"error": str(e)})
        store.add(proposal)
        return pending_payload(proposal)

    def propose_memory_delete(args: dict[str, Any]) -> str:
        memory_id = str(args.get("memory_id", "")).strip()
        if not memory_id:
            return json.dumps({"error": "memory_id is required"})
        try:
            proposal = mutation_service.propose_memory_delete(
                conn, project_id=project_id, memory_id=memory_id
            )
        except (KeyError, ValueError) as e:
            return json.dumps({"error": str(e)})
        store.add(proposal)
        return pending_payload(proposal)

    registry.register(
        name="propose_memory_write",
        description=(
            "Stage a new project memory note (or an edit to an existing one) for user "
            "confirmation. Omit `memory_id` to create a new entry; pass it to update an "
            "existing one. Returns a proposal id and diff; not saved until confirmed."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "body_md": {
                    "type": "string",
                    "description": "Markdown body of the note.",
                },
                "tags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "default": [],
                },
                "memory_id": {
                    "type": ["string", "null"],
                    "description": "Existing entry id to update; omit to create new.",
                },
            },
            "required": ["title", "body_md"],
        },
        handler=propose_memory_write,
    )
    registry.register(
        name="propose_memory_delete",
        description=(
            "Stage deletion of a project memory entry for user confirmation. "
            "Returns a proposal id; not deleted until confirmed."
        ),
        parameters={
            "type": "object",
            "properties": {
                "memory_id": {"type": "string"},
            },
            "required": ["memory_id"],
        },
        handler=propose_memory_delete,
    )


__all__ = [
    "register_memory_mutating_tools",
    "register_memory_readonly_tools",
]
