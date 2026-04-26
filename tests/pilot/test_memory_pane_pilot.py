"""Pilot coverage for the per-project memory editor modal.

Locks down the wiring so the upcoming list/edit-pane primitive collapse
can't silently regress: the binding opens the modal, list reload picks up
seeded rows, save persists through `memory_repo`, delete removes the row,
and read-only mode disables the editor."""

from __future__ import annotations

from pathlib import Path

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.memory_pane import MemoryPane
from docket.config import (
    Config,
    ProjectEntry,
    ProviderEntry,
    SavedView,
    resolve_paths,
    save_config,
)
from docket.core.model import ScopeFilters, project_id_for
from docket.core.services import project_service
from docket.storage import init_db
from docket.storage.repos import memory_repo
from tests.fakes.provider import FakeProvider


def _seeded_config() -> Config:
    return Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                views={"default": SavedView()},
                active_view="default",
            )
        },
        active_provider="main",
        projects={project_id_for("main"): ProjectEntry(provider_key="main", name="Main")},
    )


def _ctx(conn, *, read_only: bool = False) -> TuiContext:
    paths = resolve_paths()
    paths.ensure()
    cfg = _seeded_config()
    save_config(paths, cfg)
    project_service.mirror_into_db(cfg, conn)
    return TuiContext(
        conn=conn,
        provider=FakeProvider(),
        provider_key="main",
        scope=ScopeFilters(),
        paths=paths,
        config=cfg,
        read_only=read_only,
    )


async def test_open_memory_action_opens_modal(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        assert isinstance(app.screen, MemoryPane)
    conn.close()


async def test_existing_entries_load_into_editor_on_mount(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    entry = memory_repo.create(
        conn, project_id=pid, title="Glossary", body_md="ALM = …", tags=["ref"]
    )

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)
        # First entry auto-selected → form populated.
        assert modal._current_id == entry.id
        from textual.widgets import Input, TextArea

        assert modal.query_one("#title-input", Input).value == "Glossary"
        assert modal.query_one("#tags-input", Input).value == "ref"
        assert modal.query_one("#editor", TextArea).text == "ALM = …"
    conn.close()


async def test_save_persists_new_entry_through_repo(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)

        from textual.widgets import Input, TextArea

        modal.query_one("#title-input", Input).value = "Pitfall"
        modal.query_one("#tags-input", Input).value = "gotcha, prod"
        modal.query_one("#editor", TextArea).text = "Don't forget the trailing slash."
        await pilot.press("ctrl+s")
        await pilot.pause()

    rows = memory_repo.list_for_project(conn, pid)
    assert len(rows) == 1
    saved = rows[0]
    assert saved.title == "Pitfall"
    assert saved.tags == ["gotcha", "prod"]
    assert saved.body_md == "Don't forget the trailing slash."
    conn.close()


async def test_save_updates_existing_entry(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    seeded = memory_repo.create(conn, project_id=pid, title="Old", body_md="old body")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)

        from textual.widgets import Input, TextArea

        # The seeded row is auto-selected; just edit and save.
        modal.query_one("#title-input", Input).value = "New"
        modal.query_one("#editor", TextArea).text = "new body"
        await pilot.press("ctrl+s")
        await pilot.pause()

    refreshed = memory_repo.get(conn, seeded.id)
    assert refreshed is not None
    assert refreshed.title == "New"
    assert refreshed.body_md == "new body"
    conn.close()


async def test_delete_removes_entry_and_clears_editor(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    memory_repo.create(conn, project_id=pid, title="Doomed", body_md="x")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)
        assert modal._current_id is not None

        await pilot.press("ctrl+d")
        await pilot.pause()

        # Editor cleared, list emptied.
        assert modal._current_id is None
        from textual.widgets import Input

        assert modal.query_one("#title-input", Input).value == ""

    assert memory_repo.list_for_project(conn, pid) == []
    conn.close()


async def test_save_with_empty_title_does_not_persist(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)

        from textual.widgets import TextArea

        modal.query_one("#editor", TextArea).text = "no title here"
        await pilot.press("ctrl+s")
        await pilot.pause()

    assert memory_repo.list_for_project(conn, pid) == []
    conn.close()


async def test_read_only_mode_disables_editor(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn, read_only=True)

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MemoryPane)
        from textual.widgets import Button, Input, TextArea

        assert modal.query_one("#title-input", Input).disabled
        assert modal.query_one("#tags-input", Input).disabled
        assert modal.query_one("#editor", TextArea).disabled
        assert modal.query_one("#save-btn", Button).disabled
        assert modal.query_one("#delete-btn", Button).disabled
    conn.close()


async def test_escape_dismisses_modal(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_memory")
        await pilot.pause()
        assert isinstance(app.screen, MemoryPane)
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, MemoryPane)
    conn.close()
