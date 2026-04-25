"""Storage-layer timestamp helpers.

Every repo write stamps `created_at` / `updated_at` as an ISO-8601 string in
UTC. Centralizing the format in one helper keeps the audit question "do all
repos write the same shape?" answerable by reading one function.

`now_utc()` returns the same instant as a `datetime` for code that needs
to compare or arithmetic on the value before stringifying."""

from __future__ import annotations

from datetime import UTC, datetime


def now_utc() -> datetime:
    """Return the current UTC time as an aware `datetime`."""
    return datetime.now(UTC)


def now_iso() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return now_utc().isoformat()


__all__ = ["now_iso", "now_utc"]
