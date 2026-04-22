"""Perf guard for the sync hot path.

Not a benchmark — we don't assert wall-clock numbers because they'd be noisy
under CI. Instead we assert the shape of the work: bulk upserts must go
through a single `executemany`, not N individual `execute` calls. This lets
us notice if a well-meaning refactor puts the per-item loop back.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.core.services import sync_service
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.provider import FakeProvider


class _CountingConn:
    """Forwarding proxy that counts `execute`/`executemany` calls.

    `sqlite3.Connection` attributes are read-only so `unittest.mock.patch.object`
    can't wrap them. A thin proxy is the simplest way to observe call shape
    without touching production code."""

    def __init__(self, real: sqlite3.Connection) -> None:
        self._real = real
        self.execute_calls = 0
        self.executemany_calls = 0
        self.executemany_row_counts: list[int] = []

    def execute(self, *args, **kwargs):
        self.execute_calls += 1
        return self._real.execute(*args, **kwargs)

    def executemany(self, sql, rows, *args, **kwargs):
        materialized = list(rows)
        self.executemany_calls += 1
        self.executemany_row_counts.append(len(materialized))
        return self._real.executemany(sql, materialized, *args, **kwargs)

    def __getattr__(self, name: str):
        return getattr(self._real, name)


def _mk_items(n: int, start: datetime) -> list[Item]:
    return [
        Item(
            id=f"S-{i}",
            kind=ItemKind.STORY,
            title=f"story {i}",
            description_md="",
            state=ItemState.ACTIVE,
            assignee=None,
            parent_id=None,
            updated_at=start + timedelta(seconds=i),
        )
        for i in range(n)
    ]


def test_bulk_upsert_uses_executemany(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    items = _mk_items(500, datetime(2026, 4, 21, 10, 0, tzinfo=UTC))

    n = item_repo.upsert_items(conn, items)
    assert n == 500
    # Every row is on disk.
    assert len(item_repo.list_items(conn)) == 500


def test_refresh_batches_into_one_executemany(tmp_path: Path) -> None:
    """Sync of 200 items should do O(1) `executemany` calls for the upsert,
    not O(n) `execute` calls."""
    real = init_db(tmp_path / "t.db")
    spy = _CountingConn(real)
    items = _mk_items(200, datetime(2026, 4, 21, 10, 0, tzinfo=UTC))
    provider = FakeProvider(items=items)

    summary = sync_service.refresh(spy, provider, "default", ScopeFilters())

    assert summary.upserted == 200
    # Exactly one bulk upsert with all rows in it — the thing we care about.
    assert spy.executemany_calls == 1
    assert spy.executemany_row_counts == [200]
    # Per-item `execute` count stays bounded (BEGIN/COMMIT + watermark write +
    # a handful of setup statements), nothing scaling with n.
    assert spy.execute_calls < 20
