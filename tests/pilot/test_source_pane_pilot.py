"""Pilot coverage for the per-project source documents editor modal.

Locks down the wiring so the upcoming list/edit-pane primitive collapse
can't silently regress: the binding opens the modal, list reload picks up
seeded rows, save persists kind/uri/tags through `source_repo`, delete
removes the row, and read-only mode disables the editor."""

from __future__ import annotations

from pathlib import Path

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.source_pane import SourcePane
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
from docket.storage.repos import source_repo
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


async def test_open_source_action_opens_modal(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        assert isinstance(app.screen, SourcePane)
    conn.close()


async def test_existing_entries_load_into_editor_on_mount(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    entry = source_repo.create(
        conn,
        project_id=pid,
        title="Spec",
        body_md="The big spec.",
        kind="requirements",
        uri="https://example.invalid/spec",
        tags=["api"],
    )

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)
        assert modal._current_id == entry.id
        from textual.widgets import Input, TextArea

        assert modal.query_one("#title-input", Input).value == "Spec"
        assert modal.query_one("#kind-input", Input).value == "requirements"
        assert modal.query_one("#uri-input", Input).value == "https://example.invalid/spec"
        assert modal.query_one("#tags-input", Input).value == "api"
        assert modal.query_one("#editor", TextArea).text == "The big spec."
    conn.close()


async def test_save_persists_new_entry_through_repo(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)

        from textual.widgets import Input, TextArea

        modal.query_one("#title-input", Input).value = "Runbook"
        modal.query_one("#kind-input", Input).value = "runbook"
        modal.query_one("#uri-input", Input).value = "https://example.invalid/runbook"
        modal.query_one("#tags-input", Input).value = "ops, on-call"
        modal.query_one("#editor", TextArea).text = "Step 1: do the thing."
        await pilot.press("ctrl+s")
        await pilot.pause()

    rows = source_repo.list_for_project(conn, pid)
    assert len(rows) == 1
    saved = rows[0]
    assert saved.title == "Runbook"
    assert saved.kind == "runbook"
    assert saved.uri == "https://example.invalid/runbook"
    assert saved.tags == ["ops", "on-call"]
    assert saved.body_md == "Step 1: do the thing."
    conn.close()


async def test_save_updates_existing_entry(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    seeded = source_repo.create(
        conn, project_id=pid, title="Old", body_md="old body", kind="design"
    )

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)

        from textual.widgets import Input, TextArea

        modal.query_one("#title-input", Input).value = "New"
        modal.query_one("#kind-input", Input).value = "runbook"
        modal.query_one("#editor", TextArea).text = "new body"
        await pilot.press("ctrl+s")
        await pilot.pause()

    refreshed = source_repo.get(conn, seeded.id)
    assert refreshed is not None
    assert refreshed.title == "New"
    assert refreshed.kind == "runbook"
    assert refreshed.body_md == "new body"
    conn.close()


async def test_delete_removes_entry_and_clears_editor(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")
    source_repo.create(conn, project_id=pid, title="Doomed", body_md="x")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)
        assert modal._current_id is not None

        await pilot.press("ctrl+d")
        await pilot.pause()
        assert modal._current_id is None
        from textual.widgets import Input

        assert modal.query_one("#title-input", Input).value == ""

    assert source_repo.list_for_project(conn, pid) == []
    conn.close()


async def test_save_with_empty_title_does_not_persist(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn)
    pid = project_id_for("main")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)

        from textual.widgets import TextArea

        modal.query_one("#editor", TextArea).text = "no title here"
        await pilot.press("ctrl+s")
        await pilot.pause()

    assert source_repo.list_for_project(conn, pid) == []
    conn.close()


async def test_read_only_mode_disables_editor(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(conn, read_only=True)

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_source")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, SourcePane)
        from textual.widgets import Button, Input, TextArea

        assert modal.query_one("#title-input", Input).disabled
        assert modal.query_one("#kind-input", Input).disabled
        assert modal.query_one("#uri-input", Input).disabled
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
        await app.run_action("open_source")
        await pilot.pause()
        assert isinstance(app.screen, SourcePane)
        await pilot.press("escape")
        await pilot.pause()
        assert not isinstance(app.screen, SourcePane)
    conn.close()
