"""Pilot coverage for background sync, saved views, and the stale marker.

Each test stays narrow to one behavior so a breakage points at the exact
surface. Shared fixture seeds a DB + provider with items whose `updated_at`
timestamps are tuned for the scenario."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from docket.cli.tui import DocketApp, TuiContext
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.status_bar import StatusBar, _format_countdown
from docket.config.models import Config, ProviderEntry, ScopeFilter
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.provider import FakeProvider


def _mk_item(
    id: str,
    *,
    updated_at: datetime | None = None,
    title: str = "A story",
) -> Item:
    return Item(
        id=id,
        kind=ItemKind.STORY,
        title=title,
        description_md="",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=updated_at or datetime.now(UTC),
    )


def _find_label(node, target_id: str) -> str | None:
    for child in node.children:
        if child.data == target_id:
            return str(child.label)
        found = _find_label(child, target_id)
        if found is not None:
            return found
    return None


def _single_provider_cfg(
    *,
    scopes: dict[str, ScopeFilter],
    active_scope: str = "default",
    key: str = "azure_devops",
) -> Config:
    """Build a Config whose single provider entry carries the given scopes.

    Centralized so each test reads as one specific scenario without repeating
    the ProviderEntry boilerplate."""
    entry = ProviderEntry(
        type="azure_devops",
        display_name="Azure DevOps",
        config={"organization": "https://dev.azure.com/o", "project": "p"},
        scopes=scopes,
        active_scope=active_scope,
    )
    return Config(providers={key: entry}, active_provider=key)


@pytest.fixture
def stale_ctx(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    now = datetime.now(UTC)
    fresh = _mk_item("S-fresh", updated_at=now, title="Just updated")
    stale = _mk_item("S-stale", updated_at=now - timedelta(days=14), title="Two weeks old")
    for it in (fresh, stale):
        item_repo.upsert_item(conn, it)
    provider = FakeProvider(items=[fresh, stale])
    yield TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
        stale_threshold_days=7,
    )
    conn.close()


async def test_stale_marker_only_on_old_rows(stale_ctx) -> None:
    app = DocketApp(stale_ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = app.query_one(ItemTree)
        stale_label = _find_label(tree.root, "S-stale")
        fresh_label = _find_label(tree.root, "S-fresh")
        assert stale_label is not None
        assert "14d" in stale_label
        assert fresh_label is not None
        assert "0d" in fresh_label


async def test_stale_marker_disabled_when_threshold_zero(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    old = _mk_item("S-old", updated_at=datetime.now(UTC) - timedelta(days=365))
    item_repo.upsert_item(conn, old)
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[old]),
        scope=ScopeFilters(),
        scope_key="default",
        stale_threshold_days=0,
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            label = _find_label(app.query_one(ItemTree).root, "S-old")
            assert label is not None
            assert "365d" in label
    finally:
        conn.close()


async def test_stale_per_provider_override(tmp_path: Path) -> None:
    """Per-provider override beats the global default."""
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item("S-1", updated_at=datetime.now(UTC) - timedelta(days=10))
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    # Global default is 30 (item not stale) but this provider's override is 7.
    ctx = TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
        stale_threshold_days=30,
        stale_threshold_by_provider={"FakeProvider": 7},
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            label = _find_label(app.query_one(ItemTree).root, "S-1")
            assert label is not None
            assert "10d" in label
    finally:
        conn.close()


async def test_status_bar_shows_active_view_and_next_sync(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item("S-1")
    item_repo.upsert_item(conn, item)
    cfg = _single_provider_cfg(
        scopes={"default": ScopeFilter(), "my-team": ScopeFilter(team="Team A")},
        active_scope="my-team",
    )
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[item]),
        provider_key="azure_devops",
        scope=ScopeFilters(team="Team A"),
        scope_key="my-team",
        background_sync_interval_seconds=300.0,
        config=cfg,
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            bar = app.query_one(StatusBar)
            assert bar.scope_label == "my-team"
            assert bar.active_view == "my-team"
            # Next-sync is scheduled ~300s in the future on mount.
            assert bar.next_sync_at is not None
            delta = (bar.next_sync_at - datetime.now(UTC)).total_seconds()
            assert 200 < delta <= 300
    finally:
        conn.close()


async def test_switch_view_reloads_tree_with_new_scope(tmp_path: Path) -> None:
    """Switch view through the action and verify scope_key + status bar update."""
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item("S-1")
    item_repo.upsert_item(conn, item)
    cfg = _single_provider_cfg(
        scopes={
            "default": ScopeFilter(),
            "blocked": ScopeFilter(area_path="Blocked"),
        },
    )
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[item]),
        provider_key="azure_devops",
        scope=ScopeFilters(),
        scope_key="default",
        config=cfg,
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.run_action("switch_view('blocked')")
            await pilot.pause()
            assert ctx.scope_key == "blocked"
            assert ctx.scope.area_path == "Blocked"
            bar = app.query_one(StatusBar)
            assert bar.scope_label == "blocked"
            assert bar.active_view == "blocked"
    finally:
        conn.close()


async def test_switch_view_rejects_unknown_name(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    cfg = _single_provider_cfg(scopes={"default": ScopeFilter()})
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[]),
        provider_key="azure_devops",
        scope=ScopeFilters(),
        scope_key="default",
        config=cfg,
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            await app.run_action("switch_view('nope')")
            await pilot.pause()
            # Scope unchanged on unknown name.
            assert ctx.scope_key == "default"
    finally:
        conn.close()


async def test_palette_exposes_switch_view_entries(tmp_path: Path) -> None:
    """The switch-view command appears in the palette's discovery list,
    once per configured scope other than the active one."""
    from docket.cli.tui.commands import DocketCommands

    conn = init_db(tmp_path / "docket.db")
    cfg = _single_provider_cfg(
        scopes={
            "default": ScopeFilter(),
            "blocked": ScopeFilter(),
            "my-team": ScopeFilter(),
        },
    )
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[]),
        provider_key="azure_devops",
        scope=ScopeFilters(),
        scope_key="default",
        config=cfg,
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            provider = DocketCommands(app.screen, match_style=None)  # type: ignore[arg-type]
            labels = [c.label for c in provider._commands()]
            assert "Switch view → blocked" in labels
            assert "Switch view → my-team" in labels
            # Active view is filtered out.
            assert "Switch view → default" not in labels
    finally:
        conn.close()


def test_provider_floor_clamps_background_sync(tmp_path: Path) -> None:
    """Regression guard on the resolver helper — no need to mount the app."""
    conn = init_db(tmp_path / "docket.db")
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[]),
        scope=ScopeFilters(),
        scope_key="default",
        background_sync_interval_seconds=60.0,
        background_sync_min_interval_by_provider={"FakeProvider": 900.0},
    )
    app = DocketApp(ctx)
    try:
        assert app._resolved_sync_interval() == 900.0
    finally:
        conn.close()


def test_disabled_sync_stays_disabled_despite_floor(tmp_path: Path) -> None:
    """0 means off — a floor must not revive the timer."""
    conn = init_db(tmp_path / "docket.db")
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[]),
        scope=ScopeFilters(),
        scope_key="default",
        background_sync_interval_seconds=0.0,
        background_sync_min_interval_by_provider={"FakeProvider": 900.0},
    )
    app = DocketApp(ctx)
    try:
        assert app._resolved_sync_interval() == 0.0
    finally:
        conn.close()


def test_countdown_formatter_handles_ranges() -> None:
    now = datetime.now(UTC)
    assert _format_countdown(None) == "—"
    assert _format_countdown(now - timedelta(seconds=5)) == "now"
    assert _format_countdown(now + timedelta(seconds=30)).endswith("s")
    assert _format_countdown(now + timedelta(minutes=5)).endswith("m")
    assert _format_countdown(now + timedelta(hours=3)).endswith("h")
