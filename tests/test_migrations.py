from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from docket.storage import APPLICATION_ID, LATEST_VERSION, init_db


def test_fresh_init_creates_all_tables(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    app_id = conn.execute("PRAGMA application_id").fetchone()[0]
    assert version == LATEST_VERSION
    assert app_id == APPLICATION_ID
    tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
    }
    assert tables == {
        "attachments",
        "comments",
        "conversations",
        "items",
        "messages",
        "sync_state",
    }
    conn.close()


def test_reopen_is_noop(tmp_path: Path) -> None:
    db = tmp_path / "docket.db"
    init_db(db).close()
    # second open should not error and user_version unchanged
    conn = init_db(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST_VERSION
    conn.close()


def test_rejects_foreign_application_id(tmp_path: Path) -> None:
    db = tmp_path / "bad.db"
    c = sqlite3.connect(db)
    c.execute("PRAGMA application_id = 0x12345678")
    c.commit()
    c.close()
    with pytest.raises(RuntimeError, match="application_id"):
        init_db(db)


def test_upgrade_from_v1_adds_tool_columns(tmp_path: Path) -> None:
    """A database stamped at user_version=1 should upgrade cleanly to LATEST."""
    db = tmp_path / "v1.db"
    conn = init_db(db)
    # Simulate a pre-v2 database by dropping everything added after v1.
    conn.execute("ALTER TABLE messages DROP COLUMN tool_call_id")
    conn.execute("ALTER TABLE messages DROP COLUMN tool_name")
    conn.execute("ALTER TABLE items DROP COLUMN url")
    conn.execute("PRAGMA user_version = 1")
    conn.close()

    conn = init_db(db)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST_VERSION
    cols = {r[1] for r in conn.execute("PRAGMA table_info(messages)")}
    assert "tool_call_id" in cols
    assert "tool_name" in cols
    item_cols = {r[1] for r in conn.execute("PRAGMA table_info(items)")}
    assert "url" in item_cols
    conn.close()


def test_rejects_future_user_version(tmp_path: Path) -> None:
    db = tmp_path / "future.db"
    conn = init_db(db)
    conn.execute(f"PRAGMA user_version = {LATEST_VERSION + 99}")
    conn.close()
    with pytest.raises(RuntimeError, match="newer than"):
        init_db(db)
