from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from platformdirs import PlatformDirs

APP_NAME = "docket"
_dirs = PlatformDirs(appname=APP_NAME, appauthor=False, roaming=False)


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
    def env_file(self) -> Path:
        return self.config_dir / ".env"

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
    # Seed repo-local `.env` into os.environ before reading XDG_* so the
    # override always takes effect, regardless of entry point. Idempotent.
    from docket.config.env import load_project_env

    load_project_env()
    return Paths(
        config_dir=_xdg_or("XDG_CONFIG_HOME", Path(_dirs.user_config_dir)),
        state_dir=_xdg_or("XDG_STATE_HOME", Path(_dirs.user_state_dir)),
        cache_dir=_xdg_or("XDG_CACHE_HOME", Path(_dirs.user_cache_dir)),
    )
