from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import HttpUrl

from docket.config import (
    AdoConfig,
    Config,
    ConfigMissingError,
    ScopeFilter,
    load_config,
    resolve_paths,
    save_config,
)


def test_paths_respect_xdg(tmp_xdg: Path) -> None:
    p = resolve_paths()
    assert str(p.config_dir).startswith(str(tmp_xdg / "config"))
    assert str(p.state_dir).startswith(str(tmp_xdg / "state"))
    assert str(p.cache_dir).startswith(str(tmp_xdg / "cache"))
    assert p.db_file.name == "docket.db"
    assert p.config_file.name == "config.toml"


def test_config_roundtrip(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    cfg = Config(
        ado=AdoConfig(
            organization=HttpUrl("https://dev.azure.com/example"),
            project="Demo",
        ),
        scopes={
            "default": ScopeFilter(area_path="Demo\\Team A", assignee="@me"),
            "alt": ScopeFilter(assignee="alice@example.com"),
        },
    )
    save_config(paths, cfg)
    loaded = load_config(paths)
    assert loaded.ado.project == "Demo"
    assert loaded.scopes["default"].area_path == "Demo\\Team A"
    assert loaded.scopes["alt"].assignee == "alice@example.com"
    assert loaded.telemetry.enabled is True  # default


def test_load_missing_config_raises(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    with pytest.raises(ConfigMissingError):
        load_config(paths)
