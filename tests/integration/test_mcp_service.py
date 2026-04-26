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
    SavedView,
    load_config,
    resolve_paths,
    save_config,
)
from docket.config.mcp_presets import apply_preset, get_preset
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
                views={"default": SavedView()},
                active_view="default",
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
            transport="grpc",
        )


def test_add_http_round_trips_url_and_headers(tmp_xdg: Path) -> None:
    """http transport persists `url` and `headers`; the stdio fields are
    dropped on save so on-disk config stays canonical."""
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(
        config,
        paths,
        pid,
        "remote",
        transport="http",
        url="https://api.example.com/mcp",
        headers={"Authorization": "Bearer token-1"},
        # Provide stdio fields too so we can confirm they're stripped.
        command="/should/not/persist",
        args=["--ignored"],
        env={"IGNORED": "yes"},
        startup_timeout_seconds=12.0,
    )
    reloaded = load_config(paths)
    entry = mcp_service.get_server(reloaded, pid, "remote")
    assert entry.transport == "http"
    assert entry.url == "https://api.example.com/mcp"
    assert entry.headers == {"Authorization": "Bearer token-1"}
    assert entry.command == ""
    assert entry.args == []
    assert entry.env == {}
    assert entry.startup_timeout_seconds == 12.0


def test_add_sse_requires_url(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    with pytest.raises(mcp_service.InvalidServerConfigError):
        mcp_service.add_server(config, paths, pid, "remote", transport="sse")


def test_add_stdio_requires_command(tmp_xdg: Path) -> None:
    """stdio still needs a command; we don't allow it to be omitted just
    because http/sse exist."""
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    with pytest.raises(mcp_service.InvalidServerConfigError):
        mcp_service.add_server(config, paths, pid, "fake", transport="stdio")


def test_update_can_swap_transport_to_http(tmp_xdg: Path) -> None:
    """Updating transport=stdio→http drops command/args/env in favour of
    url/headers. Mirrors the user reaching for "Save" after switching the
    Select in the form."""
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    mcp_service.add_server(
        config, paths, pid, "fake", command="/bin/true", args=["a"], env={"K": "V"}
    )
    mcp_service.update_server(
        config,
        paths,
        pid,
        "fake",
        transport="http",
        url="https://api.example.com/mcp",
        headers={"Authorization": "Bearer t"},
    )
    entry = mcp_service.get_server(config, pid, "fake")
    assert entry.transport == "http"
    assert entry.url == "https://api.example.com/mcp"
    assert entry.headers == {"Authorization": "Bearer t"}
    assert entry.command == ""
    assert entry.args == []
    assert entry.env == {}


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


def _save_preset_entry(config, paths, pid: str, entry, name: str) -> object:
    return mcp_service.add_server(
        config,
        paths,
        pid,
        name,
        command=entry.command,
        args=list(entry.args),
        env=dict(entry.env),
        transport=entry.transport,
        enabled=entry.enabled,
        startup_timeout_seconds=entry.startup_timeout_seconds,
    )


def test_add_from_preset_persists_full_entry(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    preset = get_preset("github")
    entry = apply_preset("github", env={"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"})
    saved = _save_preset_entry(config, paths, pid, entry, preset.default_name)
    assert preset.default_name == "github"
    assert saved.command == "npx"
    assert saved.args == ["-y", "@modelcontextprotocol/server-github"]
    assert saved.env == {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"}
    # Round-trip through TOML.
    reloaded = load_config(paths)
    on_disk = mcp_service.get_server(reloaded, pid, "github")
    assert on_disk.command == "npx"
    assert on_disk.env["GITHUB_PERSONAL_ACCESS_TOKEN"] == "ghp_fake"


def test_add_from_preset_respects_name_override(tmp_xdg: Path) -> None:
    config, pid = _seeded(tmp_xdg)
    paths = resolve_paths()
    entry = apply_preset("github", env={"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"})
    _save_preset_entry(config, paths, pid, entry, "gh-work")
    assert "gh-work" in mcp_service.list_servers(config, pid)


def test_add_from_preset_rejects_missing_env(tmp_xdg: Path) -> None:
    _seeded(tmp_xdg)
    with pytest.raises(mcp_service.MissingPresetEnvError):
        apply_preset("github", env={})


def test_add_from_preset_rejects_unknown_id(tmp_xdg: Path) -> None:
    _seeded(tmp_xdg)
    with pytest.raises(mcp_service.UnknownPresetError):
        get_preset("nonexistent")
