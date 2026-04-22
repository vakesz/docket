from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from docket.storage.schema import APPLICATION_ID, STATEMENTS


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
    _validate_application_id(conn)
    _init_schema(conn)
    return conn


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
