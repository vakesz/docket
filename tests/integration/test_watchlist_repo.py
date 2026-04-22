"""Watchlist repo: pin/unpin, ordering, idempotency, archived-item filtering."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.core import Item, ItemKind, ItemState
from docket.storage import init_db, transaction
from docket.storage.repos import item_repo, watchlist_repo


def _make_item(id: str = "1", **overrides: object) -> Item:
    base = dict(
        id=id,
        kind=ItemKind.STORY,
        title=f"item {id}",
        description_md="",
        state=ItemState.ACTIVE,
        assignee=None,
        parent_id=None,
        updated_at=datetime(2026, 4, 21, 10, 0, tzinfo=UTC),
    )
    base.update(overrides)
    return Item(**base)  # type: ignore[arg-type]


def test_pin_unpin_roundtrip(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1"))
        watchlist_repo.pin(conn, "1")
    assert watchlist_repo.is_pinned(conn, "1") is True
    assert watchlist_repo.list_pinned_ids(conn) == ["1"]
    with transaction(conn):
        watchlist_repo.unpin(conn, "1")
    assert watchlist_repo.is_pinned(conn, "1") is False
    assert watchlist_repo.list_pinned_ids(conn) == []


def test_pin_is_idempotent_and_refreshes_timestamp(tmp_path: Path) -> None:
    """Re-pinning an already-pinned item must not raise and should update
    `pinned_at` so the newest re-pin bubbles to the top of the list."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1"))
        item_repo.upsert_item(conn, _make_item("2"))
        watchlist_repo.pin(conn, "1", at=datetime(2026, 4, 20, tzinfo=UTC))
        watchlist_repo.pin(conn, "2", at=datetime(2026, 4, 21, tzinfo=UTC))
    assert watchlist_repo.list_pinned_ids(conn) == ["2", "1"]
    # Re-pin "1" with a newer timestamp — it should jump ahead.
    with transaction(conn):
        watchlist_repo.pin(conn, "1", at=datetime(2026, 4, 22, tzinfo=UTC))
    assert watchlist_repo.list_pinned_ids(conn) == ["1", "2"]


def test_unpin_missing_is_noop(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        watchlist_repo.unpin(conn, "does-not-exist")
    assert watchlist_repo.list_pinned_ids(conn) == []


def test_list_pinned_items_orders_newest_first(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("a", title="alpha"))
        item_repo.upsert_item(conn, _make_item("b", title="bravo"))
        watchlist_repo.pin(conn, "a", at=datetime(2026, 4, 20, tzinfo=UTC))
        watchlist_repo.pin(conn, "b", at=datetime(2026, 4, 21, tzinfo=UTC))
    items = watchlist_repo.list_pinned_items(conn)
    assert [i.id for i in items] == ["b", "a"]
    assert items[0].title == "bravo"


def test_list_pinned_items_drops_missing_and_archived(tmp_path: Path) -> None:
    """An id that was pinned then archived (or deleted) must not appear —
    we don't FK on items.id, so the join silently filters. This is the
    contract that lets sync archival race with pinning without bookkeeping."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("live"))
        item_repo.upsert_item(conn, _make_item("gone"))
        watchlist_repo.pin(conn, "live")
        watchlist_repo.pin(conn, "gone")
        watchlist_repo.pin(conn, "never-existed")
        item_repo.mark_archived(conn, ["gone"])
    ids = [i.id for i in watchlist_repo.list_pinned_items(conn)]
    assert ids == ["live"]
    # But `list_pinned_ids` still reports all three — the join is the filter.
    assert set(watchlist_repo.list_pinned_ids(conn)) == {"live", "gone", "never-existed"}
