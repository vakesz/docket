from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from docket.core.model import Item, ItemKind, ItemState
from docket.core.services import conversation_service, external_update_service
from docket.core.services.external_update_service import EXTERNAL_UPDATE_MARKER
from docket.storage import init_db
from docket.storage.repos import conversation_repo, item_repo, message_repo
from tests.fakes.provider import FakeProvider


def _item(
    *,
    id: str = "S-1",
    title: str = "Login",
    state: ItemState = ItemState.NEW,
    updated: datetime | None = None,
    description: str = "Add login.",
) -> Item:
    return Item(
        id=id,
        kind=ItemKind.STORY,
        title=title,
        description_md=description,
        state=state,
        assignee=None,
        parent_id=None,
        updated_at=updated or datetime(2026, 4, 21, 10, 0, tzinfo=UTC),
    )


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    yield conn, provider, item
    conn.close()


def test_noop_when_updated_at_unchanged(env) -> None:
    conn, provider, item = env
    result = external_update_service.check_and_inject(conn, provider, item.id)
    assert result.changed is False
    assert result.diff == ""
    assert result.injected_message_id is None


def test_detects_title_change_and_upserts(env) -> None:
    conn, provider, item = env
    newer = datetime.now(UTC) + timedelta(seconds=1)
    provider.items = [replace(item, title="Login (v2)", updated_at=newer)]

    result = external_update_service.check_and_inject(conn, provider, item.id)

    assert result.changed is True
    assert "title" in result.diff
    cached = item_repo.get_item(conn, item.id)
    assert cached is not None and cached.title == "Login (v2)"


def test_injects_system_message_into_active_conversation(env) -> None:
    conn, provider, item = env
    convo = conversation_repo.create(conn, item.id)

    newer = datetime.now(UTC) + timedelta(seconds=1)
    provider.items = [replace(item, state=ItemState.ACTIVE, updated_at=newer)]

    result = external_update_service.check_and_inject(conn, provider, item.id)

    assert result.changed is True
    assert result.injected_message_id is not None

    msgs = message_repo.list_for_conversation(conn, convo.id, live_only=False)
    system_msgs = [m for m in msgs if EXTERNAL_UPDATE_MARKER in (m.content or "")]
    assert len(system_msgs) == 1
    assert "state:" in system_msgs[0].content


def test_no_conversation_means_no_message_injected(env) -> None:
    conn, provider, item = env
    # No conversation opened yet.
    newer = datetime.now(UTC) + timedelta(seconds=1)
    provider.items = [replace(item, state=ItemState.ACTIVE, updated_at=newer)]

    result = external_update_service.check_and_inject(conn, provider, item.id)

    assert result.changed is True
    assert result.injected_message_id is None


def test_injection_only_into_active_not_archived(env) -> None:
    conn, provider, item = env
    archived = conversation_repo.create(conn, item.id)
    conversation_service.archive_thread(conn, archived.id)
    active = conversation_repo.create(conn, item.id)

    newer = datetime.now(UTC) + timedelta(seconds=1)
    provider.items = [replace(item, title="renamed", updated_at=newer)]

    external_update_service.check_and_inject(conn, provider, item.id)

    active_msgs = message_repo.list_for_conversation(conn, active.id, live_only=False)
    archived_msgs = message_repo.list_for_conversation(conn, archived.id, live_only=False)
    assert any(EXTERNAL_UPDATE_MARKER in (m.content or "") for m in active_msgs)
    assert not any(EXTERNAL_UPDATE_MARKER in (m.content or "") for m in archived_msgs)


def test_diff_describes_common_field_changes() -> None:
    before = _item(title="Login", state=ItemState.NEW, description="a")
    after = _item(title="Login v2", state=ItemState.ACTIVE, description="ab")
    diff = external_update_service.diff_items(before, after)
    assert "title" in diff
    assert "state" in diff
    assert "description" in diff


def test_diff_falls_back_to_generic_when_no_tracked_field_moved() -> None:
    before = _item()
    after = _item()  # identical tracked fields
    diff = external_update_service.diff_items(before, after)
    assert "metadata" in diff.lower()


def test_naive_vs_aware_datetimes_still_compare() -> None:
    """SQLite round-trips can drop tz; the watcher must handle naive cached rows
    without falsely reporting 'no change' when the provider ships aware ones."""
    naive_cached = _item(updated=datetime(2026, 4, 21, 10, 0))  # naive
    aware_fresh = _item(updated=datetime(2026, 4, 21, 11, 0, tzinfo=UTC))
    # Expose _has_advanced through the public diff path: if advanced, diff is
    # computed (but in this case fields are identical — still returns changed=True
    # via check_and_inject, which we simulate manually here).
    assert external_update_service._has_advanced(naive_cached, aware_fresh) is True
