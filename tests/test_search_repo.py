"""FTS5-backed search across items + their comments.

These cover the common user-facing shapes — title/description/comment hits,
prefix matching, implicit AND across multiple terms — plus structural
checks: that the triggers keep the FTS row in sync when the underlying
item or comment changes, and that malformed user input falls back to LIKE
instead of blowing up.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.core import Comment, Item, ItemKind, ItemState
from docket.storage import init_db, transaction
from docket.storage.repos import comment_repo, item_repo, search_repo


def _mk(id: str, title: str = "title", description_md: str = "") -> Item:
    return Item(
        id=id,
        kind=ItemKind.STORY,
        title=title,
        description_md=description_md,
        state=ItemState.ACTIVE,
        assignee=None,
        parent_id=None,
        updated_at=datetime(2026, 4, 21, 10, 0, tzinfo=UTC),
    )


def _comment(id: str, item_id: str, body: str) -> Comment:
    return Comment(
        id=id,
        item_id=item_id,
        author="u",
        body_md=body,
        created_at=datetime(2026, 4, 21, 10, 5, tzinfo=UTC),
    )


def test_empty_query_returns_empty(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="anything"))
    assert search_repo.search(conn, "") == []
    assert search_repo.search(conn, "   ") == []


def test_title_match(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="login crashes on safari"))
        item_repo.upsert_item(conn, _mk("2", title="unrelated"))
    assert search_repo.search(conn, "login") == ["1"]
    assert search_repo.search(conn, "safari") == ["1"]


def test_description_match(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(
            conn,
            _mk("1", title="ticket one", description_md="users report slow queries"),
        )
        item_repo.upsert_item(conn, _mk("2", title="ticket two", description_md="other text"))
    assert search_repo.search(conn, "slow") == ["1"]


def test_comment_match(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="t1"))
        comment_repo.replace_comments_for_item(
            conn, "1", [_comment("c1", "1", "repro steps are in jira AUTH-42")]
        )
    assert search_repo.search(conn, "AUTH-42") == ["1"]
    assert search_repo.search(conn, "jira") == ["1"]


def test_prefix_match(tmp_path: Path) -> None:
    """Typing `auth` while searching should find `authentication`."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="authentication failure on prod"))
    assert search_repo.search(conn, "auth") == ["1"]


def test_multi_term_is_and(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="login bug on safari"))
        item_repo.upsert_item(conn, _mk("2", title="login bug on chrome"))
        item_repo.upsert_item(conn, _mk("3", title="slow queries on safari"))
    # Each whitespace-separated term must be present.
    assert search_repo.search(conn, "login safari") == ["1"]


def test_update_invalidates_old_match(tmp_path: Path) -> None:
    """Rewriting an item's title should make the old term stop matching."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="apple"))
    assert search_repo.search(conn, "apple") == ["1"]
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="banana"))
    assert search_repo.search(conn, "apple") == []
    assert search_repo.search(conn, "banana") == ["1"]


def test_comment_delete_invalidates_match(tmp_path: Path) -> None:
    """When a comment is replaced out, its content should no longer match."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="t1"))
        comment_repo.replace_comments_for_item(conn, "1", [_comment("c1", "1", "unique-token-xyz")])
    assert search_repo.search(conn, "unique-token-xyz") == ["1"]
    with transaction(conn):
        comment_repo.replace_comments_for_item(conn, "1", [])
    assert search_repo.search(conn, "unique-token-xyz") == []


def test_special_chars_dont_crash(tmp_path: Path) -> None:
    """FTS5 chokes on raw quotes and operators; we strip them per-term so the
    query still returns a best-effort result."""
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _mk("1", title="issue AB-123 in handler"))
    # `AB-123` contains a hyphen (FTS5 operator); must not raise.
    assert search_repo.search(conn, "AB-123") == ["1"]
    # Double-quote should be stripped, not blow up.
    assert search_repo.search(conn, '"handler') == ["1"]
