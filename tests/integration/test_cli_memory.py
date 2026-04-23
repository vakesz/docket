"""CLI smoke tests for `docket memory ...`."""

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


def test_memory_list_when_empty(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(app, ["memory", "list"])
    assert result.exit_code == 0, result.stdout
    assert "No memory entries" in result.stdout


def test_memory_add_then_list(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    add = runner.invoke(
        app,
        ["memory", "add", "Glossary", "--body", "ALM=…", "--tags", "ref,glossary"],
    )
    assert add.exit_code == 0, add.stdout
    assert "Added" in add.stdout

    listed = runner.invoke(app, ["memory", "list"])
    assert listed.exit_code == 0, listed.stdout
    assert "Glossary" in listed.stdout
    assert "ref" in listed.stdout


def test_memory_add_requires_body(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(app, ["memory", "add", "Title only"])
    assert result.exit_code != 0


def test_memory_search_finds_entry(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["memory", "add", "Auth", "--body", "OAuth tokens"])
    runner.invoke(app, ["memory", "add", "Other", "--body", "unrelated"])
    result = runner.invoke(app, ["memory", "search", "OAuth"])
    assert result.exit_code == 0, result.stdout
    assert "Auth" in result.stdout
    assert "Other" not in result.stdout


def test_memory_edit_and_rm(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["memory", "add", "Original", "--body", "v1"])
    listed = runner.invoke(app, ["memory", "list"])
    # Pull the 8-char id prefix from the table output.
    for line in listed.stdout.splitlines():
        if "Original" in line:
            mem_prefix = line.strip().split()[0].strip("│ ")
            break
    else:
        raise AssertionError(f"could not parse list output:\n{listed.stdout}")

    edited = runner.invoke(app, ["memory", "edit", mem_prefix, "--title", "Renamed"])
    assert edited.exit_code == 0, edited.stdout
    assert "Updated" in edited.stdout

    removed = runner.invoke(app, ["memory", "rm", mem_prefix, "--yes"])
    assert removed.exit_code == 0, removed.stdout
    assert "Removed" in removed.stdout
