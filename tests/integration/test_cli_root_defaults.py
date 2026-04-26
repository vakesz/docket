"""Regression guards on the default-subcommand root callback.

The bare `docket` invocation routes through `_root -> run_open_tui`. Calling
`open_command` directly would hand Click's `typer.OptionInfo` sentinels to
the Python function as defaults — truthy objects that silently flip
`--read-only` on and stringify `--provider` as `<OptionInfo ...>`.

`run_open_tui` is a keyword-only impl that accepts nothing but primitives.
This test locks that wiring by patching `run_open_tui`, invoking the real
CLI with no args, and asserting the captured flags are all real primitives."""

from typing import Any

import pytest
from typer.testing import CliRunner

from docket.cli import app as cli_app_module
from docket.cli.commands import open as open_module


def test_bare_invocation_passes_real_defaults_to_run_open_tui(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def _recording_run_open_tui(
        *,
        view: str | None,
        no_chat: bool,
        read_only: bool,
        provider: str | None,
    ) -> None:
        captured["view"] = view
        captured["no_chat"] = no_chat
        captured["read_only"] = read_only
        captured["provider"] = provider

    # Patch in both the module that defines it and the module that imports
    # it — `_root` references the imported symbol.
    monkeypatch.setattr(open_module, "run_open_tui", _recording_run_open_tui)
    monkeypatch.setattr(cli_app_module, "run_open_tui", _recording_run_open_tui)

    result = CliRunner().invoke(cli_app_module.app, [])
    assert result.exit_code == 0, result.output
    for name, value in captured.items():
        assert value is None or isinstance(value, (str, bool)), (
            f"option '{name}' received non-primitive default {value!r} "
            f"(likely a typer.OptionInfo sentinel)"
        )
    assert captured == {
        "view": None,
        "no_chat": False,
        "read_only": False,
        "provider": None,
    }
