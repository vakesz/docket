"""Concrete read-only tools for M4. Bound to a sqlite connection + provider.

Lookup strategy: cache-first, fall through to provider on miss. Provider
failures surface as structured errors rather than exceptions so the model
sees the failure and can reason about it.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Any

from docket.agent.tools import ToolRegistry
from docket.core.model import Item
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, item_repo


def _item_summary(item: Item) -> dict[str, Any]:
    return {
        "id": item.id,
        "kind": item.kind.value,
        "title": item.title,
        "state": item.state.value,
        "assignee": item.assignee,
        "parent_id": item.parent_id,
        "tags": list(item.tags),
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        "url": item.url,
    }


def register_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
) -> None:
    def get_item(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        item = item_repo.get_item(conn, id_)
        if item is None:
            try:
                item = provider.get_item(id_)
            except Exception as e:
                return json.dumps({"error": f"provider lookup failed: {e}"})
        payload = _item_summary(item)
        payload["description_md"] = item.description_md
        return json.dumps(payload)

    def get_comments(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        comments = comment_repo.list_comments(conn, id_)
        if not comments:
            try:
                comments = provider.get_comments(id_)
            except Exception as e:
                return json.dumps({"error": f"provider lookup failed: {e}"})
        return json.dumps(
            [
                {
                    "id": c.id,
                    "author": c.author,
                    "created_at": c.created_at.isoformat(),
                    "body_md": c.body_md,
                }
                for c in comments
            ]
        )

    def get_linked(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        try:
            linked = provider.get_linked(id_)
        except Exception as e:
            return json.dumps({"error": f"provider lookup failed: {e}"})
        return json.dumps([_item_summary(i) for i in linked])

    def search_items(args: dict[str, Any]) -> str:
        query = str(args.get("query", "")).strip().lower()
        limit = int(args.get("limit", 20) or 20)
        if not query:
            return json.dumps({"error": "query is required"})
        matches = [
            i
            for i in item_repo.list_items(conn)
            if query in i.title.lower() or query in (i.description_md or "").lower()
        ][:limit]
        return json.dumps([_item_summary(i) for i in matches])

    registry.register(
        name="get_item",
        description="Fetch full details (including description) for a work item by id. Tries cache, falls back to provider.",
        parameters={
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Work item id"}},
            "required": ["id"],
        },
        handler=get_item,
    )
    registry.register(
        name="get_comments",
        description="List comments on a work item, oldest-first. Returns author, created_at, and Markdown body.",
        parameters={
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
        handler=get_comments,
    )
    registry.register(
        name="get_linked_items",
        description="List items linked to the given id (related, parent, children). Provider-backed.",
        parameters={
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
        handler=get_linked,
    )
    registry.register(
        name="search_items",
        description="Search the local cache by substring match against title and description. Returns up to `limit` summaries.",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
        },
        handler=search_items,
    )


__all__ = ["_item_summary", "register_readonly_tools"]
