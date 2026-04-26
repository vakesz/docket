"""CLI smoke tests for `docket status`."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from typer.testing import CliRunner

from docket.cli.app import app
from docket.config import (
    Config,
    ProviderEntry,
    SavedView,
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
                views={"default": SavedView()},
                active_view="default",
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


def test_status_verbose_surfaces_recent_events(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    # Seed the log with a handful of structured events that match the filter.
    paths = resolve_paths()
    log_file = paths.log_dir / "docket.log"
    log_file.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "2026-04-23T09:00:00 INFO docket.agent.tools: "
        + json.dumps(
            {"event": "tool_call", "tool_name": "get_item", "outcome": "ok", "latency_ms": 12}
        ),
        "2026-04-23T09:00:01 INFO docket.core.services.mutation_service: "
        + json.dumps(
            {
                "event": "proposal_confirm",
                "proposal_type": "StateChange",
                "outcome": "ok",
                "latency_ms": 87,
            }
        ),
        "2026-04-23T09:00:02 INFO docket.agent.mcp.manager: "
        + json.dumps(
            {
                "event": "mcp_bind",
                "tool_name": "github:search",
                "outcome": "error",
                "error_type": "invalid_config",
            }
        ),
    ]
    log_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = CliRunner().invoke(app, ["status", "--verbose"])
    assert result.exit_code == 0, result.stdout
    out = result.stdout
    assert "Recent events" in out
    assert "tool_call" in out
    assert "proposal_confirm" in out
    assert "mcp_bind" in out
    assert "invalid_config" in out


def test_status_verbose_handles_missing_log(tmp_xdg: Path) -> None:
    _seed(tmp_xdg)
    result = CliRunner().invoke(app, ["status", "--verbose"])
    assert result.exit_code == 0, result.stdout
    # Fresh install: either no log file, or log file has no matching events.
    out = result.stdout
    assert "Recent events" in out
    assert "No log file yet" in out or "No tool / proposal / MCP events" in out
