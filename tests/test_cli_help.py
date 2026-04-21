from __future__ import annotations

from typer.testing import CliRunner

from docket.cli.app import app

runner = CliRunner()


def test_help_command_lists_aliases() -> None:
    result = runner.invoke(app, ["help"])
    assert result.exit_code == 0
    assert "open" in result.stdout
    assert "browse, ui" in result.stdout
    assert "ls" in result.stdout


def test_help_topic_accepts_alias_name() -> None:
    result = runner.invoke(app, ["help", "browse"])
    assert result.exit_code == 0
    assert "docket open" in result.stdout
    assert "Aliases: browse, ui" in result.stdout


def test_list_alias_exposes_same_help_as_primary_command() -> None:
    result = runner.invoke(app, ["ls", "--help"])
    assert result.exit_code == 0
    assert "List items from the local cache." in result.stdout


def test_open_alias_exposes_same_help_as_primary_command() -> None:
    result = runner.invoke(app, ["browse", "--help"])
    assert result.exit_code == 0
    assert "Launch the three-pane Textual TUI." in result.stdout
