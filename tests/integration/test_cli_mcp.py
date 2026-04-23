"""CLI smoke tests for `docket mcp ...`."""

from __future__ import annotations

import sys
from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import (
    Config,
    ProviderEntry,
    ScopeFilter,
    load_config,
    resolve_paths,
    save_config,
)
from docket.core.model import project_id_for


def _seed(tmp_xdg: Path) -> None:
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


def _pid() -> str:
    return project_id_for("main")


def test_mcp_list_when_empty(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(app, ["mcp", "list"])
    assert result.exit_code == 0, result.stdout
    assert "No MCP servers" in result.stdout


def test_mcp_add_then_list_persists_to_config(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    add = runner.invoke(
        app,
        [
            "mcp",
            "add",
            "fake",
            "--command",
            sys.executable,
            "--args",
            "-m tests.fakes.mcp_server",
            "--env",
            "FOO=bar",
            "--timeout",
            "12.5",
        ],
    )
    assert add.exit_code == 0, add.stdout
    assert "Added" in add.stdout

    listed = runner.invoke(app, ["mcp", "list"])
    assert listed.exit_code == 0, listed.stdout
    assert "fake" in listed.stdout
    assert "yes" in listed.stdout  # enabled column

    # Verify the entry round-trips through config.toml at the right project key.
    paths = resolve_paths()
    cfg = load_config(paths)
    pid = _pid()
    assert pid in cfg.projects, list(cfg.projects)
    entries = cfg.projects[pid].mcp
    assert "fake" in entries
    entry = entries["fake"]
    assert entry.command == sys.executable
    assert entry.args == ["-m", "tests.fakes.mcp_server"]
    assert entry.env == {"FOO": "bar"}
    assert entry.startup_timeout_seconds == 12.5
    assert entry.enabled is True


def test_mcp_add_rejects_duplicate(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["mcp", "add", "fake", "--command", "/bin/true"])
    dup = runner.invoke(app, ["mcp", "add", "fake", "--command", "/bin/false"])
    assert dup.exit_code != 0
    assert "already exists" in dup.stdout


def test_mcp_disable_then_enable(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["mcp", "add", "fake", "--command", "/bin/true"])
    off = runner.invoke(app, ["mcp", "disable", "fake"])
    assert off.exit_code == 0, off.stdout
    paths = resolve_paths()
    cfg = load_config(paths)
    assert cfg.projects[_pid()].mcp["fake"].enabled is False

    on = runner.invoke(app, ["mcp", "enable", "fake"])
    assert on.exit_code == 0, on.stdout
    cfg = load_config(paths)
    assert cfg.projects[_pid()].mcp["fake"].enabled is True


def test_mcp_rm_removes_entry(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(app, ["mcp", "add", "fake", "--command", "/bin/true"])
    rm = runner.invoke(app, ["mcp", "rm", "fake", "--yes"])
    assert rm.exit_code == 0, rm.stdout
    assert "Removed" in rm.stdout
    paths = resolve_paths()
    cfg = load_config(paths)
    assert "fake" not in cfg.projects[_pid()].mcp


def test_mcp_rm_unknown_server_is_error(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    res = runner.invoke(app, ["mcp", "rm", "ghost", "--yes"])
    assert res.exit_code != 0


def test_mcp_test_starts_real_server_and_lists_tools(tmp_xdg: Path) -> None:
    """Live handshake against the fake stdio server."""
    _seed(tmp_xdg)
    runner = CliRunner()
    runner.invoke(
        app,
        [
            "mcp",
            "add",
            "fake",
            "--command",
            sys.executable,
            "--args",
            "-m tests.fakes.mcp_server",
            "--timeout",
            "15",
        ],
    )
    res = runner.invoke(app, ["mcp", "test", "fake"])
    assert res.exit_code == 0, res.stdout
    assert "Connected" in res.stdout
    assert "mcp__fake__echo" in res.stdout
    assert "mcp__fake__boom" in res.stdout


def test_mcp_test_unknown_server_is_error(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    res = runner.invoke(app, ["mcp", "test", "ghost"])
    assert res.exit_code != 0


def test_mcp_add_rejects_bad_env_format(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    res = runner.invoke(
        app,
        ["mcp", "add", "fake", "--command", "/bin/true", "--env", "no_equals_here"],
    )
    assert res.exit_code != 0


def test_mcp_presets_lists_github(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(app, ["mcp", "presets"])
    assert result.exit_code == 0, result.stdout
    assert "github" in result.stdout
    assert "GITHUB_PERSONAL_ACCESS_TOKEN" in result.stdout


def test_mcp_add_preset_github_persists(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "mcp",
            "add-preset",
            "github",
            "--env",
            "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_fake",
        ],
    )
    assert result.exit_code == 0, result.stdout
    assert "Added" in result.stdout

    cfg = load_config(resolve_paths())
    entry = cfg.projects[_pid()].mcp["github"]
    assert entry.command == "npx"
    assert entry.args == ["-y", "@modelcontextprotocol/server-github"]
    assert entry.env == {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"}


def test_mcp_add_preset_rejects_missing_env(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(app, ["mcp", "add-preset", "github"])
    assert result.exit_code != 0
    assert "Missing env value" in result.stdout


def test_mcp_add_preset_rejects_unknown_id(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(
        app,
        ["mcp", "add-preset", "nonexistent", "--env", "FOO=bar"],
    )
    assert result.exit_code != 0
    assert "Unknown preset" in result.stdout


def test_mcp_add_preset_respects_name_override(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(
        app,
        [
            "mcp",
            "add-preset",
            "github",
            "--name",
            "gh-work",
            "--env",
            "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_fake",
        ],
    )
    assert result.exit_code == 0, result.stdout
    cfg = load_config(resolve_paths())
    assert "gh-work" in cfg.projects[_pid()].mcp
    assert "github" not in cfg.projects[_pid()].mcp
