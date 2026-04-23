"""Pilot coverage for the MCP server editor modal.

Smaller than the CLI/HTTP suites — those already cover the
`mcp_service` semantics. This file just verifies the TUI wiring:
the binding opens the modal, Save persists through `mcp_service`,
and Delete drops the entry."""

from __future__ import annotations

from pathlib import Path

from docket.cli.tui import DocketApp, TuiContext
from docket.cli.tui.widgets.mcp_pane import MCPPane
from docket.config import (
    Config,
    ProjectEntry,
    ProviderEntry,
    ScopeFilter,
    load_config,
    resolve_paths,
    save_config,
)
from docket.core.model import ScopeFilters, project_id_for
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


def _seeded_config(paths_dir: Path) -> Config:
    return Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="main",
        projects={project_id_for("main"): ProjectEntry(provider_key="main", name="Main")},
    )


def _ctx(tmp_xdg: Path, conn) -> TuiContext:
    paths = resolve_paths()
    paths.ensure()
    cfg = _seeded_config(tmp_xdg)
    # Persist so `load_config` round-trips have something to read even
    # when a test never triggers a save through the modal.
    save_config(paths, cfg)
    return TuiContext(
        conn=conn,
        provider=FakeProvider(),
        provider_key="main",
        scope=ScopeFilters(),
        scope_key="default",
        paths=paths,
        config=cfg,
    )


async def test_open_mcp_action_opens_modal(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(tmp_xdg, conn)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_mcp")
        await pilot.pause()
        assert isinstance(app.screen, MCPPane)
    conn.close()


async def test_save_persists_new_server_through_service(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(tmp_xdg, conn)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_mcp")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MCPPane)

        # Fresh project → empty list, editor already cleared. Fill the form.
        modal.query_one("#name-input").value = "demo"
        modal.query_one("#command-input").value = "/usr/bin/python"
        modal.query_one("#args-input").value = "-m demo.server"
        modal.query_one("#env-input").text = "FOO=bar\nBAZ=qux"
        modal.query_one("#timeout-input").value = "12.5"
        await pilot.press("ctrl+s")
        await pilot.pause()

    reloaded = load_config(resolve_paths())
    project = reloaded.projects[project_id_for("main")]
    assert "demo" in project.mcp
    entry = project.mcp["demo"]
    assert entry.command == "/usr/bin/python"
    assert entry.args == ["-m", "demo.server"]
    assert entry.env == {"FOO": "bar", "BAZ": "qux"}
    assert entry.startup_timeout_seconds == 12.5
    conn.close()


async def test_delete_removes_entry_and_clears_editor(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(tmp_xdg, conn)
    # Pre-seed a server entry directly on the in-memory config so the
    # modal opens with a populated list.
    pid = project_id_for("main")
    from docket.config.models import MCPServerEntry

    ctx.config.projects[pid].mcp["doomed"] = MCPServerEntry(command="/bin/true")
    save_config(ctx.paths, ctx.config)

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_mcp")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MCPPane)
        # Modal should have auto-selected the only entry.
        assert modal._current_name == "doomed"
        await pilot.press("ctrl+d")
        await pilot.pause()

    reloaded = load_config(resolve_paths())
    assert reloaded.projects[pid].mcp == {}
    conn.close()


async def test_save_with_invalid_env_blocks_persistence(tmp_xdg: Path) -> None:
    conn = init_db(resolve_paths().db_file)
    ctx = _ctx(tmp_xdg, conn)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_mcp")
        await pilot.pause()
        modal = app.screen
        assert isinstance(modal, MCPPane)

        modal.query_one("#name-input").value = "broken"
        modal.query_one("#command-input").value = "/usr/bin/python"
        modal.query_one("#env-input").text = "no_equals_sign"
        await pilot.press("ctrl+s")
        await pilot.pause()

    reloaded = load_config(resolve_paths())
    pid = project_id_for("main")
    # Validation failure → nothing persisted.
    assert "broken" not in reloaded.projects[pid].mcp
    conn.close()
