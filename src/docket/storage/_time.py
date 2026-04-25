"""Storage-layer timestamp helper.

Every repo write stamps `created_at` / `updated_at` as an ISO-8601 string in
UTC. Centralizing the format in one helper keeps the audit question "do all
repos write the same shape?" answerable by reading one function."""

from __future__ import annotations

from datetime import UTC, datetime


def now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(UTC).isoformat()


__all__ = ["now_iso"]
