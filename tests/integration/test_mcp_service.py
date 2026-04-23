"""Unit-style coverage for `docket.core.services.mcp_service`.

Lives in `integration/` because every operation actually round-trips
through `save_config` → tomli-w → tomllib → `Config.model_validate`,
which is the only way to catch TOML serialization regressions on the
nested `[projects.<id>.mcp.<name>]` section."""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.config import (
    Config,
    ProjectEntry,
    ProviderEntry,
    ScopeFilter,
    load_config,
    resolve_paths,
    save_config,
)
from docket.core.model import project_id_for
from docket.core.services import mcp_service


def _seeded(tmp_xdg: Path) -> tuple[Config, str]:
    paths = resolve_paths()
    paths.ensure()
    pid = project_id_for("main")
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
        projects={pid: ProjectEntry(provider_key="main", name="Main")},
    )
    save_config(paths, config)
    return config, pid


def test_add_then_list_round_trips_through_toml(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(
        config,
        paths,
        pid,
        "fake",
        command="/usr/bin/python",
        args=["-m", "fake"],
        env={"FOO": "bar"},
        startup_timeout_seconds=20.0,
    )
    reloaded = load_config(paths)
    entries = mcp_service.list_servers(reloaded, pid)
    assert list(entries) == ["fake"]
    entry = entries["fake"]
    assert entry.command == "/usr/bin/python"
    assert entry.args == ["-m", "fake"]
    assert entry.env == {"FOO": "bar"}
    assert entry.startup_timeout_seconds == 20.0


def test_add_rejects_duplicate(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(config, paths, pid, "fake", command="/bin/true")
    with pytest.raises(mcp_service.DuplicateServerError):
        mcp_service.add_server(config, paths, pid, "fake", command="/bin/false")


def test_update_preserves_unset_fields(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(
        config, paths, pid, "fake", command="/bin/true", args=["a"], env={"K": "V"}
    )
    mcp_service.update_server(config, paths, pid, "fake", enabled=False)
    entry = mcp_service.get_server(config, pid, "fake")
    assert entry.enabled is False
    assert entry.command == "/bin/true"
    assert entry.args == ["a"]
    assert entry.env == {"K": "V"}


def test_update_can_clear_args_and_env(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(
        config, paths, pid, "fake", command="/bin/true", args=["a"], env={"K": "V"}
    )
    mcp_service.update_server(config, paths, pid, "fake", args=[], env={})
    entry = mcp_service.get_server(config, pid, "fake")
    assert entry.args == []
    assert entry.env == {}


def test_add_rejects_unsupported_transport(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    with pytest.raises(mcp_service.InvalidServerConfigError):
        mcp_service.add_server(
            config,
            paths,
            pid,
            "fake",
            command="/bin/true",
            transport="sse",
        )


def test_update_rejects_nonpositive_timeout(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(config, paths, pid, "fake", command="/bin/true")
    with pytest.raises(mcp_service.InvalidServerConfigError):
        mcp_service.update_server(config, paths, pid, "fake", startup_timeout_seconds=0.0)


def test_remove_then_list_is_empty(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(config, paths, pid, "fake", command="/bin/true")
    mcp_service.remove_server(config, paths, pid, "fake")
    assert mcp_service.list_servers(config, pid) == {}


def test_unknown_project_raises(tmp_xdg: Path) -> None:
    config, _pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    with pytest.raises(mcp_service.UnknownProjectError):
        mcp_service.add_server(config, paths, "ghost", "fake", command="/bin/true")
    with pytest.raises(mcp_service.UnknownProjectError):
        mcp_service.list_servers(config, "ghost")


def test_unknown_server_raises(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    with pytest.raises(mcp_service.UnknownServerError):
        mcp_service.get_server(config, pid, "ghost")
    with pytest.raises(mcp_service.UnknownServerError):
        mcp_service.update_server(config, paths, pid, "ghost", enabled=False)
    with pytest.raises(mcp_service.UnknownServerError):
        mcp_service.remove_server(config, paths, pid, "ghost")
