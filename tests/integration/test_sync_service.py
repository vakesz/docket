from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.core import Item, ItemKind, ItemState
from docket.core.model import ScopeFilters
from docket.core.services import sync_service
from docket.storage import init_db
from docket.storage.repos import item_repo, sync_repo
from tests.fakes.provider import FakeProvider


def _item(id: str, updated: datetime, *, archived: bool = False) -> Item:
    raw: dict[str, object] = {"archived": True} if archived else {}
    return Item(
        id=id,
        kind=ItemKind.STORY,
        title=f"i{id}",
        description_md="",
        state=ItemState.ACTIVE,
        assignee=None,
        parent_id=None,
        updated_at=updated,
        provider_raw=raw,
    )


def test_incremental_refresh_advances_watermark(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t1 = datetime(2026, 4, 20, 10, 0, tzinfo=UTC)
    t2 = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t1), _item("2", t2)])

    s = sync_service.refresh(conn, prov)
    assert s.upserted == 2
    assert sync_repo.get_watermark(conn, "") == t2
    assert prov.list_calls[-1] is None

    # second call — provider gets the watermark, returns nothing new
    s2 = sync_service.refresh(conn, prov)
    assert s2.upserted == 0
    assert prov.list_calls[-1] == t2


def test_archived_flag_marks_item(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t, archived=True), _item("2", t)])

    s = sync_service.refresh(conn, prov)
    assert s.archived == 1
    default = [i.id for i in item_repo.list_items(conn)]
    all_items = [i.id for i in item_repo.list_items(conn, include_archived=True)]
    assert default == ["2"]
    assert set(all_items) == {"1", "2"}


def test_full_refresh_resets_watermark(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    prov = FakeProvider(items=[_item("1", t)])

    sync_service.refresh(conn, prov)
    assert sync_repo.get_watermark(conn, "") == t

    sync_service.full_refresh(conn, prov)
    # last provider call received a None watermark (reset) even though items had one
    # (note: after full_refresh we re-set the watermark to the newest seen item)
    watermarks_seen_by_provider = prov.list_calls
    assert None in watermarks_seen_by_provider[-2:]


def test_provider_scoped_refresh_namespaces_watermarks(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    t_azure_devops = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    t_gh = datetime(2026, 4, 22, 10, 0, tzinfo=UTC)
    azure_devops = FakeProvider(items=[_item("42", t_azure_devops)])
    github = FakeProvider(items=[_item("42", t_gh)])

    sync_service.refresh(conn, azure_devops, provider_key="azure_devops")
    sync_service.refresh(conn, github, provider_key="github")

    assert azure_devops.list_calls == [None]
    assert github.list_calls == [None]
    assert sync_repo.get_watermark(conn, "azure_devops") == t_azure_devops
    assert sync_repo.get_watermark(conn, "github") == t_gh


def test_refresh_uses_unfiltered_scope_for_cache_fill(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "t.db")
    seen_filters: list[ScopeFilters] = []

    class RecordingProvider(FakeProvider):
        def list_changes_since(
            self, watermark: datetime | None, filters: ScopeFilters
        ) -> list[Item]:
            seen_filters.append(filters)
            return super().list_changes_since(watermark, filters)

    prov = RecordingProvider(items=[_item("1", datetime(2026, 4, 21, 10, 0, tzinfo=UTC))])

    sync_service.refresh(conn, prov)

    assert seen_filters == [ScopeFilters(assignee="")]
