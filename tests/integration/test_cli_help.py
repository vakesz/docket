from __future__ import annotations

from typer.testing import CliRunner

from docket.cli.app import app

runner = CliRunner()


def test_help_command_lists_top_level_commands() -> None:
    result = runner.invoke(app, ["help"])
    assert result.exit_code == 0
    assert "open" in result.stdout
    assert "list" in result.stdout
    assert "sync" in result.stdout


def test_help_topic_renders_command_summary() -> None:
    result = runner.invoke(app, ["help", "open"])
    assert result.exit_code == 0
    assert "docket open" in result.stdout


def test_help_topic_for_unknown_command_exits_nonzero() -> None:
    result = runner.invoke(app, ["help", "bogus"])
    assert result.exit_code == 2
