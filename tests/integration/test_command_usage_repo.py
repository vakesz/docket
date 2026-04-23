"""Command-palette usage counter: record/recent_ids round-trips."""

from __future__ import annotations

import time
from pathlib import Path

from docket.storage import init_db
from docket.storage.repos import command_usage_repo


def test_record_and_recent_ids(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")

    command_usage_repo.record(conn, "sync-now")
    time.sleep(0.01)
    command_usage_repo.record(conn, "pick-theme")
    time.sleep(0.01)
    command_usage_repo.record(conn, "show-help")

    assert command_usage_repo.recent_ids(conn) == ["show-help", "pick-theme", "sync-now"]


def test_record_is_upsert(tmp_path: Path) -> None:
    """Re-recording the same id must not duplicate rows and should refresh
    the last_used_at so the id bubbles back to the top."""
    conn = init_db(tmp_path / "t.db")

    command_usage_repo.record(conn, "sync-now")
    time.sleep(0.01)
    command_usage_repo.record(conn, "pick-theme")
    time.sleep(0.01)
    command_usage_repo.record(conn, "sync-now")

    ids = command_usage_repo.recent_ids(conn)
    assert ids[0] == "sync-now"
    assert ids.count("sync-now") == 1

    count = conn.execute(
        "SELECT usage_count FROM command_usage WHERE id = ?", ("sync-now",)
    ).fetchone()["usage_count"]
    assert count == 2


def test_recent_ids_respects_limit(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    for cid in ("a", "b", "c", "d", "e", "f"):
        command_usage_repo.record(conn, cid)
        time.sleep(0.005)

    assert command_usage_repo.recent_ids(conn, limit=3) == ["f", "e", "d"]


def test_clear_wipes_history(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    command_usage_repo.record(conn, "sync-now")
    command_usage_repo.record(conn, "pick-theme")

    command_usage_repo.clear(conn)

    assert command_usage_repo.recent_ids(conn) == []
