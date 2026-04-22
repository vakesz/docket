"""CLI-side coverage for read-only mode.

The mutation commands (`transition`, `new`, `patch`) abort before touching
the DB or provider when `DOCKET_READ_ONLY` is set. We test the command
bodies directly rather than through a Typer `CliRunner` because the guard
is the very first statement — we don't need `prepare_or_wizard()` to run
to verify the exit.

`serve` plumbs the flag into `create_app`; that path is already covered by
`tests/test_api_read_only.py`, so here we just check `get_read_only()`
honors the expected env tokens."""

from __future__ import annotations

from pathlib import Path

import pytest
import typer
from rich.console import Console

from docket.cli.commands.new import new_command
from docket.cli.commands.patch import patch_command
from docket.cli.commands.transition import transition_command
from docket.cli.guard import abort_if_read_only
from docket.config.env import get_read_only


def test_get_read_only_accepts_truthy_tokens(monkeypatch: pytest.MonkeyPatch) -> None:
    for raw in ("1", "true", "TRUE", "yes", "ON"):
        monkeypatch.setenv("DOCKET_READ_ONLY", raw)
        assert get_read_only() is True


def test_get_read_only_rejects_other_values(monkeypatch: pytest.MonkeyPatch) -> None:
    for raw in ("0", "false", "no", "off", "", "maybe"):
        monkeypatch.setenv("DOCKET_READ_ONLY", raw)
        assert get_read_only() is False


def test_abort_helper_raises_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DOCKET_READ_ONLY", "1")
    with pytest.raises(typer.Exit) as exc:
        abort_if_read_only(Console())
    assert exc.value.exit_code == 3


def test_abort_helper_noop_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DOCKET_READ_ONLY", raising=False)
    abort_if_read_only(Console())  # no raise


def test_transition_command_exits_before_touching_prepare(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOCKET_READ_ONLY", "1")
    # If the guard didn't fire, prepare_or_wizard would run and we'd blow
    # up on missing config — typer.Exit(3) proves the abort ran first.
    with pytest.raises(typer.Exit) as exc:
        transition_command(id="S-1", intent="start_work", dry_run=False)
    assert exc.value.exit_code == 3


def test_new_command_exits_before_touching_prepare(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DOCKET_READ_ONLY", "1")
    with pytest.raises(typer.Exit) as exc:
        new_command(
            kind="task",
            title="Nope",
            description_file=None,
            parent_id=None,
            assignee=None,
            tags=None,
            dry_run=False,
        )
    assert exc.value.exit_code == 3


def test_patch_command_exits_before_touching_prepare(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("DOCKET_READ_ONLY", "1")
    # Pick a path that does exist — the guard fires before the file check.
    md = tmp_path / "body.md"
    md.write_text("new body")
    with pytest.raises(typer.Exit) as exc:
        patch_command(id="S-1", from_file=md, dry_run=False)
    assert exc.value.exit_code == 3
