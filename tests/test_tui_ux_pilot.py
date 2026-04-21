"""Pilot coverage for M9 UX additions: theme picker, quick-open, command
palette, and fullscreen toggle.

These run through Textual's `run_test` driver. They're deliberately narrow —
we're verifying wiring (action opens screen, selection routes correctly,
persistence fires) rather than rendering fidelity.
"""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import HttpUrl

from docket.cli.tui import ItvApp, TuiContext
from docket.cli.tui.app import Pane
from docket.cli.tui.commands import DocketCommands
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.quick_open import QuickOpenModal
from docket.cli.tui.widgets.theme_picker import ThemePicker
from docket.config import AdoConfig, Config, ScopeFilter, load_config, resolve_paths
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.provider import FakeProvider


def _mk_item(id_: str = "S-1", *, title: str = "Add login") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title=title,
        description_md="body",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def ctx(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    yield TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
    )
    conn.close()


async def test_theme_picker_opens_previews_and_reverts_on_escape(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        original = app.theme
        await app.run_action("pick_theme")
        await pilot.pause()

        picker = app.screen
        assert isinstance(picker, ThemePicker)

        # Highlight a theme that isn't the current one to exercise live preview.
        sorted_names = sorted(app.available_themes)
        other = next(name for name in sorted_names if name != original)
        option_list = picker.query_one("OptionList")
        option_list.highlighted = sorted_names.index(other)
        await pilot.pause()
        assert app.theme == other

        # Esc must revert to the theme we opened with.
        await pilot.press("escape")
        await pilot.pause()
        assert app.theme == original


async def test_theme_picker_persists_selection_to_config(tmp_xdg: Path, ctx) -> None:
    paths = resolve_paths()
    paths.ensure()
    config = Config(
        ado=AdoConfig(
            organization=HttpUrl("https://dev.azure.com/example"),
            project="Demo",
        ),
        scopes={"default": ScopeFilter()},
    )
    ctx.paths = paths
    ctx.config = config

    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("pick_theme")
        await pilot.pause()
        sorted_names = sorted(app.available_themes)
        target = next(name for name in sorted_names if name != app.theme)
        picker = app.screen
        assert isinstance(picker, ThemePicker)
        option_list = picker.query_one("OptionList")
        option_list.highlighted = sorted_names.index(target)
        await pilot.pause()
        await pilot.press("enter")
        await pilot.pause()

    reloaded = load_config(paths)
    assert reloaded.ui.theme == target


async def test_quick_open_selects_item_via_modal(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("quick_open")
        await pilot.pause()
        assert isinstance(app.screen, QuickOpenModal)

        qo_input = app.screen.query_one("#qo-input")
        qo_input.value = "S-1"
        await qo_input.action_submit()
        await pilot.pause()

        detail = app.query_one(ItemDetail)
        meta = detail.query_one("#meta")
        assert "Add login" in str(meta.render())


async def test_quick_open_unknown_id_notifies_without_selecting(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("quick_open")
        await pilot.pause()
        qo_input = app.screen.query_one("#qo-input")
        qo_input.value = "NOPE-999"
        await qo_input.action_submit()
        await pilot.pause()

        assert app._selected_item_id is None


async def test_command_palette_provider_registered(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test():
        resolved: set[type] = set()
        for entry in app.COMMANDS:
            cls = entry() if callable(entry) and not isinstance(entry, type) else entry
            resolved.add(cls)
        assert DocketCommands in resolved


async def test_docket_commands_expose_core_actions(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test():
        provider = DocketCommands(screen=app.screen, match_style=None)
        labels = [label for label, _help, _cb in provider._commands()]
        assert {"Sync now", "Pick theme", "Fullscreen pane", "Quick-open by id"} <= set(labels)


async def test_fullscreen_toggle_maximizes_then_restores(ctx) -> None:
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        left = app.query_one("#left", Pane)
        left.focus()
        await pilot.pause()

        await app.run_action("toggle_fullscreen")
        await pilot.pause()
        assert app.screen.maximized is left

        await app.run_action("toggle_fullscreen")
        await pilot.pause()
        assert app.screen.maximized is None
