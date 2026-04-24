"""Agent-facing source tools (read-only).

Sources are reference documents curated by the human user. The agent can
list them, read individual bodies, and search by FTS, but it cannot write,
edit, or delete sources — there is intentionally no `propose_source_*`
tool. If the model needs new reference material, it should ask the user
to add it.

Tool registration order is part of the prompt prefix cache key, so the
order here is deliberate and stable: list → read → search.
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
from docket.storage.repos import source_repo


def _entry_summary(entry: Any) -> dict[str, Any]:
    return {
        "id": entry.id,
        "title": entry.title,
        "kind": entry.kind,
        "uri": entry.uri,
        "tags": list(entry.tags),
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
    }


def register_source_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    project_id: str,
) -> None:
    """Register `list_sources`, `read_source`, and `search_sources`.

    The project_id is bound at registration time so the model can't read
    sources from another project by mistake."""

    def list_sources(args: dict[str, Any]) -> str:
        limit = clamp_limit(
            args.get("limit", DEFAULT_LIST_LIMIT), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT
        )
        kind_raw = args.get("kind")
        kind = str(kind_raw).strip() if isinstance(kind_raw, str) else None
        entries = source_repo.list_for_project(conn, project_id, kind=kind or None, limit=limit)
        return json.dumps([_entry_summary(e) for e in entries])

    def read_source(args: dict[str, Any]) -> str:
        source_id = str(args.get("source_id", "")).strip()
        if not source_id:
            return json.dumps({"error": "source_id is required"})
        entry = source_repo.get(conn, source_id)
        if entry is None or entry.project_id != project_id:
            return json.dumps({"error": f"source '{source_id}' not found"})
        return json.dumps(
            {
                **_entry_summary(entry),
                "body_md": entry.body_md,
            }
        )

    def search_sources(args: dict[str, Any]) -> str:
        query = str(args.get("query", "")).strip()
        if not query:
            return json.dumps({"error": "query is required"})
        limit = clamp_limit(
            args.get("limit", DEFAULT_SEARCH_LIMIT), DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT
        )
        kind_raw = args.get("kind")
        kind = str(kind_raw).strip() if isinstance(kind_raw, str) else None
        entries = source_repo.search(conn, project_id, query, kind=kind or None, limit=limit)
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
        name="list_sources",
        description=(
            "List the most-recently-updated project source documents (titles, kinds, "
            "tags only). Use this to see what reference material is available before "
            "calling read_source. Pass `kind` to filter (e.g. 'requirements', 'design')."
        ),
        parameters={
            "type": "object",
            "properties": {
                "kind": {
                    "type": "string",
                    "description": "Optional category filter (free-text).",
                },
                "limit": {
                    "type": "integer",
                    "default": DEFAULT_LIST_LIMIT,
                    "minimum": 1,
                    "maximum": MAX_LIST_LIMIT,
                },
            },
        },
        handler=list_sources,
    )
    registry.register(
        name="read_source",
        description=("Read the full Markdown body of a single project source document by id."),
        parameters={
            "type": "object",
            "properties": {
                "source_id": {"type": "string"},
            },
            "required": ["source_id"],
        },
        handler=read_source,
    )
    registry.register(
        name="search_sources",
        description=(
            "Full-text search the project's source documents. Returns matched entries "
            "(including the full Markdown body) ordered by relevance. Pass `kind` to "
            "narrow to one category."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search terms"},
                "kind": {
                    "type": "string",
                    "description": "Optional category filter (free-text).",
                },
                "limit": {
                    "type": "integer",
                    "default": DEFAULT_SEARCH_LIMIT,
                    "minimum": 1,
                    "maximum": MAX_SEARCH_LIMIT,
                },
            },
            "required": ["query"],
        },
        handler=search_sources,
    )


__all__ = [
    "register_source_readonly_tools",
]
