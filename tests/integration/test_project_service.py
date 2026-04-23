"""Project service + repo, plus CLI/HTTP wiring smoke tests."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import Config, ProjectEntry, ProviderEntry, ScopeFilter, save_config
from docket.config.paths import resolve_paths
from docket.core.model import project_id_for
from docket.core.services import project_service
from docket.storage import init_db
from docket.storage.repos import project_repo


def _seed_config(name: str = "main", scope_name: str = "default") -> Config:
    return Config(
        providers={
            name: ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={scope_name: ScopeFilter()},
                active_scope=scope_name,
            )
        },
        active_provider=name,
    )


def test_project_repo_ensure_is_idempotent(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    p1 = project_repo.ensure(conn, provider_key="main")
    p2 = project_repo.ensure(conn, provider_key="main")
    assert p1.id == p2.id == project_id_for("main")
    assert p1.name == "main"
    rows = project_repo.list_all(conn)
    assert len(rows) == 1
    conn.close()


def test_project_service_upsert_persists_to_toml(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    conn = init_db(paths.db_file)
    config = _seed_config()
    save_config(paths, config)

    project = project_service.upsert(
        config,
        paths,
        conn,
        provider_key="main",
        name="My Project",
        description="Triage queue",
    )
    assert project.name == "My Project"
    # config.toml has the entry
    pid = project_id_for("main")
    assert config.projects[pid].name == "My Project"
    assert config.projects[pid].description == "Triage queue"
    # SQLite mirror agrees
    mirrored = project_repo.get(conn, pid)
    assert mirrored is not None
    assert mirrored.name == "My Project"
    conn.close()


def test_project_service_archive_unarchive_roundtrip(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    conn = init_db(paths.db_file)
    config = _seed_config()
    save_config(paths, config)

    project = project_service.upsert(config, paths, conn, provider_key="main", name="X")
    assert project.archived_at is None

    project_service.archive(config, paths, conn, project.id)
    assert config.projects[project.id].archived is True
    archived_row = project_repo.get(conn, project.id)
    assert archived_row is not None and archived_row.archived_at is not None

    project_service.unarchive(config, paths, conn, project.id)
    assert config.projects[project.id].archived is False
    unarchived_row = project_repo.get(conn, project.id)
    assert unarchived_row is not None and unarchived_row.archived_at is None
    conn.close()


def test_mirror_into_db_reflects_config(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    pid = project_id_for("main")
    config = Config(
        projects={
            pid: ProjectEntry(
                provider_key="main",
                name="Renamed",
                description="Hello",
            )
        },
    )
    project_service.mirror_into_db(config, conn)
    row = project_repo.get(conn, pid)
    assert row is not None
    assert row.name == "Renamed"
    assert row.description == "Hello"
    conn.close()


def test_cli_project_list_shows_active_marker(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    config = _seed_config()
    save_config(paths, config)

    runner = CliRunner()
    result = runner.invoke(app, ["project", "list"])
    assert result.exit_code == 0, result.stdout
    # Active dot is present
    assert "●" in result.stdout
    # Default name is shown
    assert "main" in result.stdout


def test_cli_project_rename_persists(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    config = _seed_config()
    save_config(paths, config)

    runner = CliRunner()
    result = runner.invoke(app, ["project", "rename", "Triage Queue"])
    assert result.exit_code == 0, result.stdout

    # Reload config from disk to confirm persistence.
    from docket.config.loader import load_config

    reloaded = load_config(paths)
    pid = project_id_for("main")
    assert reloaded.projects[pid].name == "Triage Queue"
