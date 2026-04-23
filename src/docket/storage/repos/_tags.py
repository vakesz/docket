"""Shared field normalizers for tag-bearing repos.

Tags are stored as a JSON array of strings in `tags_json`. These helpers,
together with `clean_title`, keep field handling identical across memory,
source, and any future tagged rows so behavior can't drift between tables.
"""

from __future__ import annotations

import json


def parse_tags(raw: str | None) -> list[str]:
    """Decode a `tags_json` column to a list of strings. Tolerant of NULL,
    empty, or malformed values — bad data yields `[]` rather than raising."""
    try:
        decoded = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(decoded, list):
        return []
    return [str(t) for t in decoded]


def clean_tags(tags: list[str] | None) -> list[str]:
    """Strip whitespace, drop empty entries. Accepts `None` for convenience."""
    return [t.strip() for t in (tags or []) if t and t.strip()]


def clean_title(title: str) -> str:
    """Trim whitespace; fall back to `(untitled)` if nothing survives."""
    return title.strip() or "(untitled)"
