"""Private helpers shared across agent tool modules."""

from __future__ import annotations

import json
from collections.abc import Callable
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


def provider_error(exc: BaseException) -> str:
    """Render a provider lookup failure for tool callers.

    Wording is shared across read tools so the model sees the same shape no
    matter which provider call blew up."""
    return arg_error(f"provider lookup failed: {exc}")


def provider_unsupported(operation: str) -> str:
    """Render a `NotImplementedError` from a provider as a structured error.

    The model gets a stable phrase ("provider does not support …") so it can
    branch on capability without parsing implementation-specific messages."""
    return arg_error(f"provider does not support {operation}")


def call_provider[T](operation: str, fn: Callable[[], T], render: Callable[[T], Any]) -> str:
    """Invoke `fn`, JSON-encode `render(result)`, or render the canonical
    error shape on `NotImplementedError` / unexpected provider failures.

    `operation` is the human-facing label embedded in the unsupported
    message (e.g. `"PR detail fetch"`). Centralizes the read-tool error
    triad so call sites collapse to a single return."""
    try:
        result = fn()
    except NotImplementedError:
        return provider_unsupported(operation)
    except Exception as e:
        return provider_error(e)
    return json.dumps(render(result))


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
    "call_provider",
    "clamp_limit",
    "entry_summary",
    "provider_error",
    "provider_unsupported",
    "required_str",
    "str_list",
]
