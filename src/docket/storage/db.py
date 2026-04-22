from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from docket.storage.schema import APPLICATION_ID, SCHEMA_VERSION, STATEMENTS


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False because the TUI runs LLM turns on a worker
    # thread and needs to read/write the cache from there. WAL journal mode
    # handles one-writer-many-reader safely.
    conn = sqlite3.connect(
        db_path,
        isolation_level=None,  # autocommit; we manage TX explicitly
        check_same_thread=False,
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def init_db(db_path: Path) -> sqlite3.Connection:
    conn = connect(db_path)
    try:
        _validate_application_id(conn)
        if _needs_reset(conn):
            _reset_cache_schema(conn)
        _init_schema(conn)
        return conn
    except Exception:
        conn.close()
        raise


def _validate_application_id(conn: sqlite3.Connection) -> None:
    row = conn.execute("PRAGMA application_id").fetchone()
    current = row[0] if row else 0
    if current == 0:
        conn.execute(f"PRAGMA application_id = {APPLICATION_ID}")
        return
    if current != APPLICATION_ID:
        raise RuntimeError(
            f"SQLite file has application_id=0x{current:x}; "
            f"expected 0x{APPLICATION_ID:x} (this is not a docket database)"
        )


def _init_schema(conn: sqlite3.Connection) -> None:
    with transaction(conn):
        for stmt in STATEMENTS:
            conn.execute(stmt)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _needs_reset(conn: sqlite3.Connection) -> bool:
    """Return True when the on-disk cache is from an older incompatible schema.

    Docket intentionally supports a single cache schema version at a time while
    the app is still early in development. Opening an older cache recreates it
    instead of running migrations."""
    row = conn.execute("PRAGMA user_version").fetchone()
    version = int(row[0]) if row else 0
    if version == SCHEMA_VERSION:
        return False
    has_items = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'"
    ).fetchone()
    return bool(has_items)


def _reset_cache_schema(conn: sqlite3.Connection) -> None:
    """Drop cache-backed tables in place so the next init installs the current schema."""
    with transaction(conn):
        for stmt in (
            "DROP TABLE IF EXISTS items_fts",
            "DROP TABLE IF EXISTS messages",
            "DROP TABLE IF EXISTS attachments",
            "DROP TABLE IF EXISTS conversations",
            "DROP TABLE IF EXISTS comments",
            "DROP TABLE IF EXISTS items",
            "DROP TABLE IF EXISTS sync_state",
            "DROP TABLE IF EXISTS watchlist",
        ):
            conn.execute(stmt)
        conn.execute("PRAGMA user_version = 0")


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
