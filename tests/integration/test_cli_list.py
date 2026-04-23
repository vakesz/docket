"""CLI smoke tests for `docket list`."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import Config, ProviderEntry, ScopeFilter, resolve_paths, save_config
from docket.core.model import Item, ItemKind, ItemState
from docket.storage import init_db
from docket.storage.repos import item_repo


def _seed(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    config = Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={
                    "default": ScopeFilter(assignee="@me"),
                    "all": ScopeFilter(assignee=""),
                },
                active_scope="default",
            )
        },
        active_provider="main",
    )
    save_config(paths, config)
    conn = init_db(paths.db_file)
    try:
        item_repo.upsert_item(
            conn,
            Item(
                id="S-1",
                kind=ItemKind.STORY,
                title="Mine",
                description_md="",
                state=ItemState.NEW,
                assignee="stub-user",
                parent_id=None,
                updated_at=datetime.now(UTC),
                provider_key="main",
            ),
        )
        item_repo.upsert_item(
            conn,
            Item(
                id="S-2",
                kind=ItemKind.STORY,
                title="Teammate",
                description_md="",
                state=ItemState.NEW,
                assignee="someone-else",
                parent_id=None,
                updated_at=datetime.now(UTC),
                provider_key="main",
            ),
        )
    finally:
        conn.close()


def test_list_respects_active_view_filter(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(app, ["list"])
    assert result.exit_code == 0, result.stdout
    assert "Mine" in result.stdout
    assert "Teammate" not in result.stdout
