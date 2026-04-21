from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import tomli_w

from docket.config.models import Config
from docket.config.paths import Paths


class ConfigMissingError(FileNotFoundError):
    """Raised when config.toml is not present — caller should invoke the setup wizard."""


def load_config(paths: Paths) -> Config:
    if not paths.config_file.exists():
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
        tomli_w.dump(_coerce_for_toml(data), f)
    tmp.replace(paths.config_file)


def _coerce_for_toml(value: Any) -> Any:
    """Pydantic emits HttpUrl, Path, etc. as strings in JSON mode. tomli-w only accepts
    primitives — pass-through. This hook lets us add future coercions without touching callers."""
    if isinstance(value, dict):
        return {k: _coerce_for_toml(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_coerce_for_toml(v) for v in value]
    if isinstance(value, Path):
        return str(value)
    return value
