"""Item-oriented read tools. Private sub-module of `tool_defs`.

Lookup strategy: cache-first, fall through to provider on miss. Provider
failures surface as structured errors so the model can reason about them
instead of raising into the agent loop."""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

from docket.agent._helpers import arg_error, provider_error, required_str
from docket.agent.tools import ToolRegistry
from docket.core.model import Item, ItemKind
from docket.providers.base import WorkItemProvider
from docket.storage.repos import comment_repo, item_repo

# Matches bare http(s) URLs inside markdown bodies. Trailing punctuation that's
# commonly prose-adjacent (`.`, `,`, `)`, `]`) is stripped when extracting so
# links paste cleanly into follow-on tool calls.
_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+")
_URL_TRIM = ".,;:!?"

_VALID_INCLUDE = {"comments", "linked"}


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
        "repository_url": item.repository_url,
    }


def _comment_payload(c: Any) -> dict[str, Any]:
    return {
        "id": c.id,
        "author": c.author,
        "created_at": c.created_at.isoformat(),
        "body_md": c.body_md,
    }


def _extract_links(text: str | None) -> list[str]:
    """Pull unique http(s) URLs from a markdown body, in first-seen order.

    Trimmed of trailing sentence punctuation. Keeps order so the model can
    reason about which link was mentioned first (often the primary repo)."""
    if not text:
        return []
    seen: dict[str, None] = {}
    for raw in _URL_RE.findall(text):
        url = raw.rstrip(_URL_TRIM)
        if url and url not in seen:
            seen[url] = None
    return list(seen.keys())


def _load_comments(
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    item_id: str,
    *,
    provider_key: str,
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Cache-first comment fetch. Returns (payload, error) — exactly one is None."""
    comments = comment_repo.list_comments(conn, item_id, provider_key=provider_key)
    if not comments:
        try:
            comments = provider.get_comments(item_id)
        except Exception as e:
            return None, f"provider lookup failed: {e}"
    return [_comment_payload(c) for c in comments], None


def _load_linked(
    provider: WorkItemProvider, item_id: str
) -> tuple[list[dict[str, Any]] | None, str | None]:
    """Provider-only linked-items fetch. Returns (payload, error)."""
    try:
        linked = provider.get_linked(item_id)
    except Exception as e:
        return None, f"provider lookup failed: {e}"
    return [_item_summary(i) for i in linked], None


def _parse_include(args: dict[str, Any]) -> tuple[set[str] | None, str | None]:
    """Validate the `include` array against `_VALID_INCLUDE`.

    Returns (set, None) on success or (None, error_msg) — the model gets a
    deterministic error for any token outside the allowed set."""
    raw = args.get("include") or []
    if not isinstance(raw, list):
        return None, "include must be an array of strings"
    out: set[str] = set()
    for value in raw:
        if not isinstance(value, str):
            continue
        token = value.strip().lower()
        if not token:
            continue
        if token not in _VALID_INCLUDE:
            allowed = ", ".join(sorted(_VALID_INCLUDE))
            return None, f"include must be one of: {allowed}"
        out.add(token)
    return out, None


def register_item_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    provider_key: str = "",
) -> None:
    def get_item(args: dict[str, Any]) -> str:
        try:
            id_ = required_str(args, "id")
        except ValueError as e:
            return arg_error(str(e))
        include, include_err = _parse_include(args)
        if include is None:
            return arg_error(include_err or "invalid include")
        item = item_repo.get_item(conn, id_, provider_key=provider_key)
        if item is None:
            try:
                item = provider.get_item(id_)
            except Exception as e:
                return provider_error(e)
            if provider_key:
                item.provider_key = provider_key
            # Cache on first hit so downstream tools and UI reads reuse it.
            item_repo.upsert_item(conn, item)
        payload = _item_summary(item)
        payload["description_md"] = item.description_md
        payload["links"] = _extract_links(item.description_md)
        if "comments" in include:
            comments_payload, err = _load_comments(conn, provider, id_, provider_key=provider_key)
            if err is not None:
                payload["comments_error"] = err
            else:
                payload["comments"] = comments_payload
        if "linked" in include:
            linked_payload, err = _load_linked(provider, id_)
            if err is not None:
                payload["linked_error"] = err
            else:
                payload["linked"] = linked_payload
        return json.dumps(payload)

    def get_comments(args: dict[str, Any]) -> str:
        try:
            id_ = required_str(args, "id")
        except ValueError as e:
            return arg_error(str(e))
        payload, err = _load_comments(conn, provider, id_, provider_key=provider_key)
        if err is not None:
            return arg_error(err)
        return json.dumps(payload)

    def get_linked(args: dict[str, Any]) -> str:
        try:
            id_ = required_str(args, "id")
        except ValueError as e:
            return arg_error(str(e))
        payload, err = _load_linked(provider, id_)
        if err is not None:
            return arg_error(err)
        return json.dumps(payload)

    def search_items(args: dict[str, Any]) -> str:
        try:
            query = required_str(args, "query").lower()
        except ValueError as e:
            return arg_error(str(e))
        limit = int(args.get("limit", 20) or 20)
        kind_raw = args.get("kind")
        kind: ItemKind | None = None
        if isinstance(kind_raw, str) and kind_raw.strip():
            try:
                kind = ItemKind(kind_raw.strip().lower())
            except ValueError:
                allowed = ", ".join(k.value for k in ItemKind)
                return arg_error(f"kind must be one of: {allowed}")
        cached = item_repo.list_items(conn, provider_key=provider_key)
        matches = [
            i
            for i in cached
            if (kind is None or i.kind == kind)
            and (query in i.title.lower() or query in (i.description_md or "").lower())
        ][:limit]
        if matches:
            return json.dumps([_item_summary(i) for i in matches])
        # Empty result — tell the model *why* so it doesn't retry the same
        # search with slight wording changes (a common failure mode).
        hint = (
            "local cache is empty for this provider; run `sync` or call `get_item` "
            "with a known id to populate it"
            if not cached
            else "no cached item matched; try a different keyword, narrow by `kind`, "
            "or call `get_item` with a specific id"
        )
        return json.dumps(
            {
                "matches": [],
                "cache_size": len(cached),
                "hint": hint,
            }
        )

    registry.register(
        name="get_item",
        description=(
            "Fetch full details for a work item by id. Tries the local cache, "
            "falls back to the provider. Response includes `description_md`, a "
            "`links` array of http(s) URLs found in the description, and (when "
            'known) a `repository_url` pointer. Pass `include=["comments", '
            '"linked"]` to fan out in one round instead of calling `get_comments` '
            "and `get_linked_items` separately."
        ),
        parameters={
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Work item id"},
                "include": {
                    "type": "array",
                    "items": {"type": "string", "enum": sorted(_VALID_INCLUDE)},
                    "description": (
                        "Optional bundles to fetch alongside the item. "
                        "`comments` adds a `comments` array; `linked` adds a `linked` array "
                        "of related items. Failures land in `comments_error` / `linked_error` "
                        "so the item payload still returns."
                    ),
                    "default": [],
                },
            },
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
        description=(
            "Substring-search the LOCAL item cache (title + description). Does NOT "
            "query the provider — items only appear after a sync or an explicit "
            "`get_item` call. On empty results the response includes `cache_size` "
            "and a `hint`; do NOT retry the same search with reworded queries — "
            "either narrow by `kind`, call `get_item` with a known id, or move on."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Substring to match"},
                "kind": {
                    "type": "string",
                    "description": ("Optional filter: epic / feature / story / task / bug."),
                    "enum": [k.value for k in ItemKind],
                },
                "limit": {"type": "integer", "default": 20, "minimum": 1, "maximum": 100},
            },
            "required": ["query"],
        },
        handler=search_items,
    )


__all__ = ["register_item_tools"]
