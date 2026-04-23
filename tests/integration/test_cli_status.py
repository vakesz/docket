"""CLI smoke tests for `docket status`."""

from __future__ import annotations

import sys
from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import (
    Config,
    ProviderEntry,
    ScopeFilter,
    resolve_paths,
    save_config,
)


def _seed(tmp_xdg: Path, *, http_enabled: bool = False) -> None:
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
    if http_enabled:
        config.http.enabled = True
        config.http.bind = "0.0.0.0"
        config.http.port = 9000
        config.http.token = "secret"
    save_config(paths, config)


def test_status_runs_on_fresh_install(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(app, ["status"])
    assert result.exit_code == 0, result.stdout
    out = result.stdout
    # Headline sections
    assert "Docket status" in out
    assert "Project" in out
    assert "Cache" in out
    assert "Telemetry" in out
    assert "HTTP" in out
    # Empty cache + no MCP servers should both print friendly notices
    assert "no syncs recorded yet" in out
    assert "none configured" in out


def test_status_reports_mcp_fleet_when_configured(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    runner = CliRunner()
    add = runner.invoke(
        app,
        ["mcp", "add", "fake", "--command", sys.executable, "--args", "-m tests.fakes.mcp_server"],
    )
    assert add.exit_code == 0, add.stdout
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0, result.stdout
    assert "MCP servers" in result.stdout
    assert "fake" in result.stdout


def test_status_reflects_http_config(tmp_xdg: Path) -> None:
    _seed(tmp_xdg, http_enabled=True)
    result = CliRunner().invoke(app, ["status"])
    assert result.exit_code == 0, result.stdout
    out = result.stdout
    assert "0.0.0.0:9000" in out
    # Token presence is reported as 'set', not echoed verbatim.
    assert "secret" not in out
    assert "set" in out
