from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from docket.core import Item, ItemKind, ItemState
from docket.storage import init_db, transaction
from docket.storage.repos import item_repo, watchlist_repo
from docket.storage.schema import SCHEMA_VERSION


def _item(id: str = "1") -> Item:
    return Item(
        id=id,
        kind=ItemKind.STORY,
        title=f"item {id}",
        description_md="",
        state=ItemState.ACTIVE,
        assignee=None,
        parent_id=None,
        updated_at=datetime(2026, 4, 21, 10, 0, tzinfo=UTC),
        provider_key="azure_devops",
    )


def test_init_db_resets_incompatible_cache_schema(tmp_path: Path) -> None:
    path = tmp_path / "docket.db"
    conn = init_db(path)
    with transaction(conn):
        item_repo.upsert_item(conn, _item("1"))
        watchlist_repo.pin(conn, "1", provider_key="azure_devops")
    conn.close()

    raw = sqlite3.connect(path)
    raw.execute("PRAGMA user_version = 0")
    raw.commit()
    raw.close()

    reset = init_db(path)
    try:
        assert item_repo.list_items(reset, include_archived=True) == []
        assert watchlist_repo.list_pinned_ids(reset) == []
        row = reset.execute("PRAGMA user_version").fetchone()
        assert row is not None and row[0] == SCHEMA_VERSION
    finally:
        reset.close()
