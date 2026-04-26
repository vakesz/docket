"""CLI-side coverage for read-only mode.

The mutation commands (`transition`, `new`, `patch`) abort once the context
is opened if `runtime.read_only` is true in config.toml. We test the helper
directly plus the end-to-end happy/refused paths via a fake `prepare_or_wizard`
context.

`serve` plumbs the flag and config into `create_app`; that path is already
covered by `tests/integration/test_api_read_only.py`, so here we focus on
the CLI guard."""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import typer
from rich.console import Console

from docket.cli.commands import new as new_cmd
from docket.cli.commands import patch as patch_cmd
from docket.cli.commands import transition as transition_cmd
from docket.cli.guard import abort_if_read_only
from docket.config.models import Config, RuntimeConfig


def _make_config(read_only: bool) -> Config:
    return Config(runtime=RuntimeConfig(read_only=read_only))


def test_abort_helper_raises_exit_when_config_read_only() -> None:
    with pytest.raises(typer.Exit) as exc:
        abort_if_read_only(Console(), _make_config(read_only=True))
    assert exc.value.exit_code == 3


def test_abort_helper_noop_when_config_not_read_only() -> None:
    abort_if_read_only(Console(), _make_config(read_only=False))


class _StubCtx:
    """Stands in for the `prepare_or_wizard()` context manager — only the
    fields the guard reads are populated."""

    def __init__(self, read_only: bool) -> None:
        self.config = _make_config(read_only)


@contextlib.contextmanager
def _stub_ctx(read_only: bool) -> Iterator[_StubCtx]:
    yield _StubCtx(read_only)


def test_transition_command_exits_under_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(transition_cmd, "prepare_or_wizard", lambda: _stub_ctx(read_only=True))
    with pytest.raises(typer.Exit) as exc:
        transition_cmd.transition_command(id="S-1", intent="start_work", dry_run=False)
    assert exc.value.exit_code == 3


def test_new_command_exits_under_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(new_cmd, "prepare_or_wizard", lambda: _stub_ctx(read_only=True))
    with pytest.raises(typer.Exit) as exc:
        new_cmd.new_command(
            kind="task",
            title="Nope",
            description_file=None,
            parent_id=None,
            assignee=None,
            tags=None,
            dry_run=False,
        )
    assert exc.value.exit_code == 3


def test_patch_command_exits_under_read_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(patch_cmd, "prepare_or_wizard", lambda: _stub_ctx(read_only=True))
    md = tmp_path / "body.md"
    md.write_text("new body")
    with pytest.raises(typer.Exit) as exc:
        patch_cmd.patch_command(id="S-1", from_file=md, dry_run=False)
    assert exc.value.exit_code == 3


def test_patch_command_reads_file_before_opening_context(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A missing file should still surface a clean Exit(2) before the guard
    fires — the guard is now inside the `with` block, but the file IO is not."""
    captured: dict[str, Any] = {}

    @contextlib.contextmanager
    def _never_called() -> Iterator[_StubCtx]:
        captured["entered"] = True
        yield _StubCtx(read_only=False)

    monkeypatch.setattr(patch_cmd, "prepare_or_wizard", _never_called)
    missing = tmp_path / "does-not-exist.md"
    with pytest.raises(typer.Exit) as exc:
        patch_cmd.patch_command(id="S-1", from_file=missing, dry_run=False)
    assert exc.value.exit_code == 2
    assert "entered" not in captured
