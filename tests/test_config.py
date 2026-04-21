from __future__ import annotations

from pathlib import Path

import pytest

from docket.config import (
    Config,
    ConfigMissingError,
    ProviderEntry,
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
        providers={
            "ado": ProviderEntry(
                type="azure_devops",
                display_name="Azure DevOps",
                config={"organization": "https://dev.azure.com/example", "project": "Demo"},
                scopes={
                    "default": ScopeFilter(area_path="Demo\\Team A", assignee="@me"),
                    "alt": ScopeFilter(assignee="alice@example.com"),
                },
                active_scope="default",
            ),
        },
        active_provider="ado",
    )
    save_config(paths, cfg)
    loaded = load_config(paths)
    assert loaded.active_provider == "ado"
    entry = loaded.providers["ado"]
    assert entry.type == "azure_devops"
    assert entry.config["project"] == "Demo"
    assert entry.scopes["default"].area_path == "Demo\\Team A"
    assert entry.scopes["alt"].assignee == "alice@example.com"
    assert loaded.telemetry.enabled is True  # default


def test_load_missing_config_raises(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    with pytest.raises(ConfigMissingError):
        load_config(paths)
