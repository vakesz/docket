"""Concrete read-only tools. Bound to a sqlite connection + provider.

Lookup strategy: cache-first, fall through to provider on miss. Provider
failures surface as structured errors rather than exceptions so the model
sees the failure and can reason about it.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any

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


def register_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    provider_key: str = "",
) -> None:
    def _load_comments(id_: str) -> tuple[list[dict[str, Any]] | None, str | None]:
        comments = comment_repo.list_comments(conn, id_, provider_key=provider_key)
        if not comments:
            try:
                comments = provider.get_comments(id_)
            except Exception as e:
                return None, f"provider lookup failed: {e}"
        return [_comment_payload(c) for c in comments], None

    def _load_linked(id_: str) -> tuple[list[dict[str, Any]] | None, str | None]:
        try:
            linked = provider.get_linked(id_)
        except Exception as e:
            return None, f"provider lookup failed: {e}"
        return [_item_summary(i) for i in linked], None

    def get_item(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        include_raw = args.get("include") or []
        if not isinstance(include_raw, list):
            return json.dumps({"error": "include must be an array of strings"})
        include: set[str] = set()
        for value in include_raw:
            if not isinstance(value, str):
                continue
            token = value.strip().lower()
            if token:
                if token not in _VALID_INCLUDE:
                    allowed = ", ".join(sorted(_VALID_INCLUDE))
                    return json.dumps({"error": f"include must be one of: {allowed}"})
                include.add(token)
        item = item_repo.get_item(conn, id_, provider_key=provider_key)
        if item is None:
            try:
                item = provider.get_item(id_)
            except Exception as e:
                return json.dumps({"error": f"provider lookup failed: {e}"})
            if provider_key:
                item.provider_key = provider_key
            # Cache on first hit so downstream tools and UI reads reuse it.
            item_repo.upsert_item(conn, item)
        payload = _item_summary(item)
        payload["description_md"] = item.description_md
        payload["links"] = _extract_links(item.description_md)
        if "comments" in include:
            comments_payload, err = _load_comments(id_)
            if err is not None:
                payload["comments_error"] = err
            else:
                payload["comments"] = comments_payload
        if "linked" in include:
            linked_payload, err = _load_linked(id_)
            if err is not None:
                payload["linked_error"] = err
            else:
                payload["linked"] = linked_payload
        return json.dumps(payload)

    def get_comments(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        payload, err = _load_comments(id_)
        if err is not None:
            return json.dumps({"error": err})
        return json.dumps(payload)

    def get_linked(args: dict[str, Any]) -> str:
        id_ = str(args.get("id", "")).strip()
        if not id_:
            return json.dumps({"error": "id is required"})
        payload, err = _load_linked(id_)
        if err is not None:
            return json.dumps({"error": err})
        return json.dumps(payload)

    def search_items(args: dict[str, Any]) -> str:
        query = str(args.get("query", "")).strip().lower()
        limit = int(args.get("limit", 20) or 20)
        if not query:
            return json.dumps({"error": "query is required"})
        kind_raw = args.get("kind")
        kind: ItemKind | None = None
        if isinstance(kind_raw, str) and kind_raw.strip():
            try:
                kind = ItemKind(kind_raw.strip().lower())
            except ValueError:
                allowed = ", ".join(k.value for k in ItemKind)
                return json.dumps({"error": f"kind must be one of: {allowed}"})
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

    # Optional: only providers that implement `find_related_prs` expose this
    # tool. We gate with callable() so agent registries stay narrow — hiding
    # the tool instead of returning errors keeps the model from hallucinating
    # PR URLs on providers (like github_stub) that can't actually search.
    find_prs = getattr(provider, "find_related_prs", None)
    if callable(find_prs):

        def find_related_prs(args: dict[str, Any]) -> str:
            id_ = str(args.get("id", "")).strip()
            if not id_:
                return json.dumps({"error": "id is required"})
            kws_raw = args.get("title_keywords") or []
            if not isinstance(kws_raw, list):
                return json.dumps({"error": "title_keywords must be an array of strings"})
            kws = [str(k) for k in kws_raw if isinstance(k, (str, int, float))]
            try:
                matches = find_prs(id_, kws)
            except NotImplementedError:
                return json.dumps({"error": "provider does not support PR discovery"})
            except Exception as e:
                return json.dumps({"error": f"provider lookup failed: {e}"})
            return json.dumps(
                [
                    {
                        "url": m.url,
                        "title": m.title,
                        "branch": m.branch,
                        "state": m.state,
                        "author": m.author,
                        "confidence": round(m.confidence, 2),
                    }
                    for m in matches
                ]
            )

        registry.register(
            name="find_related_prs",
            description=(
                "Find pull requests that might be related to this work item. "
                "Scans recent PRs for mentions of the id or the supplied title keywords. "
                "Returns best-effort matches with a confidence score; nothing is linked until the user confirms."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Work item id."},
                    "title_keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Short phrases from the item's title that likely appear in a related PR.",
                        "default": [],
                    },
                },
                "required": ["id"],
            },
            handler=find_related_prs,
        )


__all__ = ["_extract_links", "_item_summary", "register_readonly_tools"]
