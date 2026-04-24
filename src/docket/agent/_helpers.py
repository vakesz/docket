"""Private helpers shared across agent tool modules."""

from __future__ import annotations

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


__all__ = [
    "DEFAULT_LIST_LIMIT",
    "DEFAULT_SEARCH_LIMIT",
    "MAX_LIST_LIMIT",
    "MAX_SEARCH_LIMIT",
    "clamp_limit",
]
