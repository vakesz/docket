"""Pilot tests: `w` toggles the watchlist, pinned items render in a dedicated
'Pinned' section at the top of the tree regardless of filter or scope."""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.item_tree import ItemSelected, ItemTree
from docket.core.model import ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo, watchlist_repo
from tests.conftest import MakeItem
from tests.fakes.provider import FakeProvider


@pytest.fixture
def tui_setup(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    items = [
        make_item(id_, title=f"item {id_}", description_md="", state=ItemState.ACTIVE, kind=kind)
        for id_, kind in (
            ("S-1", ItemKind.STORY),
            ("S-2", ItemKind.STORY),
            ("B-1", ItemKind.BUG),
        )
    ]
    for it in items:
        item_repo.upsert_item(conn, it)
    provider = FakeProvider(items=items)
    ctx = TuiContext(conn=conn, provider=provider, scope=ScopeFilters())
    yield ctx
    conn.close()


async def test_pin_and_unpin_via_toggle_action(tui_setup) -> None:
    """`toggle_pin` flips the pin state and renders a Pinned bucket at top."""
    ctx = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        app.post_message(ItemSelected("S-1"))
        await pilot.pause()

        await app.run_action("toggle_pin")
        await pilot.pause()

        assert watchlist_repo.is_pinned(ctx.conn, "S-1") is True
        tree = app.query_one(ItemTree)
        assert "S-1" in tree.pinned_ids()
        # The rendered tree has a "Pinned" bucket as its first root child.
        first_label = str(tree.root.children[0].label)
        assert "Pinned" in first_label

        # Toggle off — Pinned section disappears.
        await app.run_action("toggle_pin")
        await pilot.pause()
        assert watchlist_repo.is_pinned(ctx.conn, "S-1") is False
        assert not tree.pinned_ids()


async def test_w_keybind_is_registered(tui_setup) -> None:
    """Guard: `w` stays mapped to the toggle-pin action in the keymap."""
    ctx = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        keys = {b.key: b.action for b in DocketApp.BINDINGS if hasattr(b, "key")}
        assert keys.get("w") == "toggle_pin"


async def test_toggle_pin_without_selection_is_noop(tui_setup) -> None:
    """toggle_pin with no selected item must not pin anything or crash."""
    ctx = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        await app.run_action("toggle_pin")
        await pilot.pause()
        assert watchlist_repo.list_pinned_ids(ctx.conn) == []


async def test_pinned_section_survives_filter(tui_setup) -> None:
    """A pin should still render in the Pinned bucket even when a filter
    would otherwise have excluded the item from the main list."""
    ctx = tui_setup
    watchlist_repo.pin(ctx.conn, "S-1")
    ctx.conn.commit()

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        await pilot.press("slash")  # focus filter
        await pilot.pause()
        from textual.widgets import Input

        filter_input = app.query_one("#filter", Input)
        filter_input.value = "nothing-matches-this"
        await filter_input.action_submit()
        await pilot.pause()

        tree = app.query_one(ItemTree)
        # First child is the Pinned bucket; it contains S-1.
        first_label = str(tree.root.children[0].label)
        assert "Pinned" in first_label
        pin_ids = [c.data for c in tree.root.children[0].children]
        assert pin_ids == ["S-1"]
