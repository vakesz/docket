from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from platformdirs import PlatformDirs

APP_NAME = "docket"
_dirs = PlatformDirs(appname=APP_NAME, appauthor=False, roaming=False)

# Snapshot the user's real shell XDG values at import time, before the
# top-level `--workspace` flag has had a chance to overwrite them. Subprocess
# helpers (`gh`, `az`, editors) consume this so workspace redirection stays
# scoped to docket and doesn't break unrelated tools that share the same env
# vars.
_XDG_VARS = ("XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME")
_pre_workspace_xdg: dict[str, str | None] = {key: os.environ.get(key) for key in _XDG_VARS}


def snapshot_pre_workspace_xdg() -> None:
    """Re-take the XDG snapshot. Called by the `--workspace` Typer callback
    *before* it rewrites `os.environ`, so external tools see the original
    shell-exported values regardless of the import order at startup."""
    for key in _XDG_VARS:
        _pre_workspace_xdg[key] = os.environ.get(key)


def external_tool_env() -> dict[str, str]:
    """Env for subprocesses that resolve their own config from XDG_* (gh, az,
    editors). Restores the pre-workspace XDG values on top of `os.environ`."""
    env = os.environ.copy()
    for key, original in _pre_workspace_xdg.items():
        if original is None:
            env.pop(key, None)
        else:
            env[key] = original
    return env


def _xdg_or(env_var: str, fallback: Path) -> Path:
    override = os.environ.get(env_var)
    if override:
        return Path(override).expanduser() / APP_NAME
    return fallback


@dataclass(frozen=True)
class Paths:
    config_dir: Path
    state_dir: Path
    cache_dir: Path

    @property
    def config_file(self) -> Path:
        return self.config_dir / "config.toml"

    @property
    def prompts_dir(self) -> Path:
        return self.config_dir / "prompts"

    @property
    def db_file(self) -> Path:
        return self.state_dir / "docket.db"

    @property
    def log_dir(self) -> Path:
        return self.cache_dir / "logs"

    @property
    def ledger_file(self) -> Path:
        return self.cache_dir / "ledger.jsonl"

    def ensure(self) -> None:
        for p in (self.config_dir, self.state_dir, self.cache_dir, self.prompts_dir, self.log_dir):
            p.mkdir(parents=True, exist_ok=True)


def resolve_paths() -> Paths:
    """Resolve XDG paths from `os.environ` and platform defaults.

    `XDG_*` overrides are read straight from the process environment — the
    only consumer that sets them is the top-level `--workspace` Typer
    callback (or the user's actual shell)."""
    return Paths(
        config_dir=_xdg_or("XDG_CONFIG_HOME", Path(_dirs.user_config_dir)),
        state_dir=_xdg_or("XDG_STATE_HOME", Path(_dirs.user_state_dir)),
        cache_dir=_xdg_or("XDG_CACHE_HOME", Path(_dirs.user_cache_dir)),
    )
