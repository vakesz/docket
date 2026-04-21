from __future__ import annotations

from docket.storage.schema import v1, v2, v3, v4

APPLICATION_ID = v1.APPLICATION_ID

MIGRATIONS: list[tuple[int, tuple[str, ...]]] = [
    (1, v1.STATEMENTS),
    (2, v2.STATEMENTS),
    (3, v3.STATEMENTS),
    (4, v4.STATEMENTS),
]
"""Ordered (target_version, statements). Each migration runs in a single transaction."""

LATEST_VERSION = max(v for v, _ in MIGRATIONS)
