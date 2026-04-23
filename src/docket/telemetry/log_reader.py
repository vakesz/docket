"""Tail recent structured events from the rotating JSON log.

`init_logging` formats each record as `TIMESTAMP LEVEL name: <json>`, where the
JSON blob is what `structlog.processors.JSONRenderer` emitted. This module
parses that suffix and returns the most recent events matching a type filter.

Scope is intentionally small: it's for `docket status --verbose` and similar
diagnostic surfaces, not a real query engine. For anything beyond "show me the
last handful of events", read the raw `docket.log` directly.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def tail_events(
    log_path: Path,
    *,
    event_types: tuple[str, ...] | None = None,
    limit: int = 5,
    max_scan_lines: int = 2000,
) -> list[dict[str, Any]]:
    """Return up to `limit` most recent JSON events from `log_path`.

    `event_types`, when set, filters to events whose `event` field matches.
    `max_scan_lines` bounds how much of the tail we parse — the log rotates at
    1 MB so the tail is always bounded, but we avoid scanning the full file on
    chatty installs.
    """
    if not log_path.exists():
        return []
    try:
        raw = log_path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    window = raw[-max_scan_lines:] if len(raw) > max_scan_lines else raw
    matches: list[dict[str, Any]] = []
    for line in window:
        payload = _extract_json(line)
        if payload is None:
            continue
        if event_types is not None and payload.get("event") not in event_types:
            continue
        matches.append(payload)
    return matches[-limit:]


def _extract_json(line: str) -> dict[str, Any] | None:
    """Pull the JSON payload out of a `ts level name: {...}` log line."""
    brace = line.find("{")
    if brace == -1:
        return None
    tail = line[brace:]
    try:
        obj = json.loads(tail)
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


__all__ = ["tail_events"]
