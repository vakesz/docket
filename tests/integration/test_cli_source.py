"""CLI smoke tests for `docket source ...`."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import Config, ProviderEntry, ScopeFilter, save_config


def _seed(tmp_xdg: Path) -> None:
    from docket.config.paths import resolve_paths

    paths = resolve_paths()
    paths.ensure()
    config = Config(
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
    )
    save_config(paths, config)


def test_source_list_when_empty(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(app, ["source", "list"])
    assert result.exit_code == 0, result.stdout
    assert "No source documents" in result.stdout


def test_source_add_then_list(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    add = runner.invoke(
        app,
        [
            "source",
            "add",
            "Login spec",
            "--body",
            "OAuth flow",
            "--kind",
            "requirements",
            "--tags",
            "auth",
        ],
    )
    assert add.exit_code == 0, add.stdout
    assert "Added" in add.stdout

    listed = runner.invoke(app, ["source", "list"])
    assert listed.exit_code == 0, listed.stdout
    assert "Login spec" in listed.stdout
    assert "requirements" in listed.stdout


def test_source_add_requires_body(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(app, ["source", "add", "Title only"])
    assert result.exit_code != 0


def test_source_search_finds_entry(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["source", "add", "Auth", "--body", "OAuth tokens"])
    runner.invoke(app, ["source", "add", "Other", "--body", "unrelated"])
    result = runner.invoke(app, ["source", "search", "OAuth"])
    assert result.exit_code == 0, result.stdout
    assert "Auth" in result.stdout
    assert "Other" not in result.stdout


def test_source_edit_and_rm(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["source", "add", "Original", "--body", "v1"])
    listed = runner.invoke(app, ["source", "list"])
    for line in listed.stdout.splitlines():
        if "Original" in line:
            src_prefix = line.strip().split()[0].strip("│ ")
            break
    else:
        raise AssertionError(f"could not parse list output:\n{listed.stdout}")

    edited = runner.invoke(app, ["source", "edit", src_prefix, "--title", "Renamed"])
    assert edited.exit_code == 0, edited.stdout
    assert "Updated" in edited.stdout

    removed = runner.invoke(app, ["source", "rm", src_prefix, "--yes"])
    assert removed.exit_code == 0, removed.stdout
    assert "Removed" in removed.stdout
