from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.core import Item, ItemKind, ItemState, ScopeFilters
from docket.core.services import sync_service
from docket.storage import init_db
from docket.storage.repos import item_repo, sync_repo
from tests.fakes.provider import FakeProvider


def _item(id: str, updated: datetime, *, archived: bool = False) -> Item:
    raw: dict[str, object] = {"archived": True} if archived else {}
    return Item(
        id=id, kind=ItemKind.STORY, title=f"i{id}", description_md="",
        state=ItemState.ACTIVE, assignee=None, parent_id=None,
        updated_at=updated, provider_raw=raw,
    )


def test_incremental_refresh_advances_watermark(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t1 = datetime(2026, 4, 20, 10, 0, tzinfo=UTC)
    t2 = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t1), _item("2", t2)])

    s = sync_service.refresh(conn, prov, "default", ScopeFilters())
    assert s.upserted == 2
    assert sync_repo.get_watermark(conn, "default") == t2
    assert prov.list_calls[-1] is None

    # second call — provider gets the watermark, returns nothing new
    s2 = sync_service.refresh(conn, prov, "default", ScopeFilters())
    assert s2.upserted == 0
    assert prov.list_calls[-1] == t2


def test_archived_flag_marks_item(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t, archived=True), _item("2", t)])

    s = sync_service.refresh(conn, prov, "default", ScopeFilters())
    assert s.archived == 1
    default = [i.id for i in item_repo.list_items(conn)]
    all_items = [i.id for i in item_repo.list_items(conn, include_archived=True)]
    assert default == ["2"]
    assert set(all_items) == {"1", "2"}


def test_full_refresh_resets_watermark(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t)])

    sync_service.refresh(conn, prov, "default", ScopeFilters())
    assert sync_repo.get_watermark(conn, "default") == t

    sync_service.full_refresh(conn, prov, "default", ScopeFilters())
    # last provider call received a None watermark (reset) even though items had one
    # (note: after full_refresh we re-set the watermark to the newest seen item)
    watermarks_seen_by_provider = prov.list_calls
    assert None in watermarks_seen_by_provider[-2:]
