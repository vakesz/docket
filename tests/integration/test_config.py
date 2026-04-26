from __future__ import annotations

from pathlib import Path

import pytest

from docket.config import (
    Config,
    ConfigMissingError,
    ProviderEntry,
    load_config,
    resolve_paths,
    save_config,
)
from docket.config.models import SavedView


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
        providers={
            "azure_devops": ProviderEntry(
                type="azure_devops",
                display_name="Azure DevOps",
                config={"organization": "https://dev.azure.com/example", "project": "Demo"},
                views={
                    "default": SavedView(axes={"area_path": ["Demo\\Team A"]}, assignees=["@me"]),
                    "alt": SavedView(assignees=["alice@example.com"]),
                },
                active_view="default",
            ),
        },
        active_provider="azure_devops",
    )
    save_config(paths, cfg)
    loaded = load_config(paths)
    assert loaded.active_provider == "azure_devops"
    entry = loaded.providers["azure_devops"]
    assert entry.type == "azure_devops"
    assert entry.config["project"] == "Demo"
    assert entry.views["default"].axes["area_path"] == ["Demo\\Team A"]
    assert entry.views["alt"].assignees == ["alice@example.com"]
    assert loaded.telemetry.enabled is True  # default


def test_load_missing_config_raises(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    with pytest.raises(ConfigMissingError):
        load_config(paths)
