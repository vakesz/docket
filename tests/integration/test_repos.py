from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.core import Comment, Item, ItemKind, ItemState
from docket.storage import init_db, transaction
from docket.storage.repos import comment_repo, item_repo, sync_repo


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


def test_item_upsert_and_list(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1", tags=["a", "b"]))
        item_repo.upsert_item(conn, _make_item("2", kind=ItemKind.BUG))
    listed = item_repo.list_items(conn)
    assert {i.id for i in listed} == {"1", "2"}
    bugs = item_repo.list_items(conn, kind=ItemKind.BUG)
    assert [b.id for b in bugs] == ["2"]
    i1 = item_repo.get_item(conn, "1")
    assert i1 and i1.tags == ["a", "b"]


def test_item_upsert_is_idempotent(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1", title="first"))
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1", title="second"))
    got = item_repo.get_item(conn, "1")
    assert got and got.title == "second"
    assert len(item_repo.list_items(conn)) == 1


def test_mark_archived_hides_from_default_list(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1"))
        item_repo.upsert_item(conn, _make_item("2"))
        item_repo.mark_archived(conn, ["2"])
    assert [i.id for i in item_repo.list_items(conn)] == ["1"]
    assert {i.id for i in item_repo.list_items(conn, include_archived=True)} == {"1", "2"}


def test_comments_replace_and_list(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("1"))
    c1 = Comment(
        id="c1",
        item_id="1",
        author="a",
        body_md="first",
        created_at=datetime(2026, 4, 21, 10, 1, tzinfo=UTC),
    )
    c2 = Comment(
        id="c2",
        item_id="1",
        author="b",
        body_md="second",
        created_at=datetime(2026, 4, 21, 10, 2, tzinfo=UTC),
    )
    with transaction(conn):
        comment_repo.replace_comments_for_item(conn, "1", [c1, c2])
    got = comment_repo.list_comments(conn, "1")
    assert [c.id for c in got] == ["c1", "c2"]
    # replace wipes and rewrites
    with transaction(conn):
        comment_repo.replace_comments_for_item(conn, "1", [c2])
    got = comment_repo.list_comments(conn, "1")
    assert [c.id for c in got] == ["c2"]


def test_provider_scoped_items_and_comments_do_not_collide(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    with transaction(conn):
        item_repo.upsert_item(conn, _make_item("42", title="ado item", provider_key="ado"))
        item_repo.upsert_item(conn, _make_item("42", title="gh item", provider_key="github"))
        comment_repo.replace_comments_for_item(
            conn,
            "42",
            [
                Comment(
                    id="c1",
                    item_id="42",
                    author="ado",
                    body_md="ado comment",
                    created_at=datetime(2026, 4, 21, 10, 1, tzinfo=UTC),
                )
            ],
            provider_key="ado",
        )
        comment_repo.replace_comments_for_item(
            conn,
            "42",
            [
                Comment(
                    id="c1",
                    item_id="42",
                    author="gh",
                    body_md="gh comment",
                    created_at=datetime(2026, 4, 21, 10, 2, tzinfo=UTC),
                )
            ],
            provider_key="github",
        )

    ado = item_repo.get_item(conn, "42", provider_key="ado")
    gh = item_repo.get_item(conn, "42", provider_key="github")
    assert ado and ado.title == "ado item"
    assert gh and gh.title == "gh item"
    assert [i.title for i in item_repo.list_items(conn, provider_key="ado")] == ["ado item"]
    assert [i.title for i in item_repo.list_items(conn, provider_key="github")] == ["gh item"]
    assert [c.body_md for c in comment_repo.list_comments(conn, "42", provider_key="ado")] == [
        "ado comment"
    ]
    assert [c.body_md for c in comment_repo.list_comments(conn, "42", provider_key="github")] == [
        "gh comment"
    ]


def test_sync_watermark(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    assert sync_repo.get_watermark(conn, "default") is None
    wm = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    with transaction(conn):
        sync_repo.set_watermark(conn, "default", wm)
    assert sync_repo.get_watermark(conn, "default") == wm
