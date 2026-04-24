"""Private helpers shared across agent tool modules."""

from __future__ import annotations

import json
from typing import Any

#: Canonical default/ceiling pair for `list_*` agent tools. Centralized here
#: so memory- and source-tools stay in sync; a list tool that wants a
#: non-standard cap should spell its own constant alongside the override.
DEFAULT_LIST_LIMIT = 25
MAX_LIST_LIMIT = 200

#: Canonical default/ceiling pair for `search_*` agent tools.
DEFAULT_SEARCH_LIMIT = 10
MAX_SEARCH_LIMIT = 50


def clamp_limit(raw: Any, default: int, max_val: int) -> int:
    try:
        return max(1, min(int(raw), max_val))
    except (TypeError, ValueError):
        return default


def required_str(args: dict[str, Any], key: str) -> str:
    """Return `args[key]` coerced to a stripped non-empty string.

    Raises `ValueError(f"{key} is required")` if the value is missing, blank,
    or whitespace-only. Handlers catch this and forward to `arg_error`."""
    value = str(args.get(key, "")).strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def str_list(args: dict[str, Any], key: str) -> list[str]:
    """Return `args[key]` coerced to a list of strings.

    Missing or `None` yields `[]`. A non-list raises `ValueError`. Elements
    that aren't str/int/float are filtered out."""
    raw = args.get(key)
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"{key} must be an array")
    return [str(t) for t in raw if isinstance(t, str | int | float)]


def arg_error(msg: str) -> str:
    """JSON-encoded `{"error": msg}` payload expected by agent tool handlers."""
    return json.dumps({"error": msg})


def entry_summary(entry: Any, **extras: Any) -> dict[str, Any]:
    """Shared summary shape for agent list/search tools over memory/source entries.

    Returns the fields every memory/source tool surfaces (id, title, tags,
    updated_at). Caller adds per-kind extras like `source=` or `kind=`/`uri=`
    as keyword arguments."""
    return {
        "id": entry.id,
        "title": entry.title,
        "tags": list(entry.tags),
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
        **extras,
    }


__all__ = [
    "DEFAULT_LIST_LIMIT",
    "DEFAULT_SEARCH_LIMIT",
    "MAX_LIST_LIMIT",
    "MAX_SEARCH_LIMIT",
    "arg_error",
    "clamp_limit",
    "entry_summary",
    "required_str",
    "str_list",
]
