from __future__ import annotations

import tomllib
from typing import Any, Literal, overload

import tomli_w

from docket.config.models import Config
from docket.config.paths import Paths


class ConfigMissingError(FileNotFoundError):
    """Raised when config.toml is not present — caller should invoke the setup wizard."""


@overload
def load_config(paths: Paths, *, optional: Literal[False] = ...) -> Config: ...
@overload
def load_config(paths: Paths, *, optional: Literal[True]) -> Config | None: ...
def load_config(paths: Paths, *, optional: bool = False) -> Config | None:
    """Read and validate `config.toml`.

    By default, raise `ConfigMissingError` when the file is absent — surfaces
    that gate on onboarding (CLI root, `/setup/status`) rely on this to
    trigger the wizard. Pass `optional=True` to return `None` instead, used
    by flows that can operate on a default `Config()` (the wizard itself
    while rebuilding state)."""
    if not paths.config_file.exists():
        if optional:
            return None
        raise ConfigMissingError(str(paths.config_file))
    with paths.config_file.open("rb") as f:
        raw: dict[str, Any] = tomllib.load(f)
    return Config.model_validate(raw)


def save_config(paths: Paths, config: Config) -> None:
    """Write atomically: write to tmp then replace."""
    paths.ensure()
    data = config.model_dump(mode="json", exclude_none=True)
    tmp = paths.config_file.with_suffix(".toml.tmp")
    with tmp.open("wb") as f:
        tomli_w.dump(data, f)
    tmp.replace(paths.config_file)
