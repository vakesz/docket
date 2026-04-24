"""Settings-patch orchestration shared by HTTP (and, eventually, any other
headless surface) so config mutation doesn't drift across adapters.

The HTTP PATCH endpoint and wizard updates both need the same three-step
pipeline: mask a masked token echoed back from the client, deep-merge the
patch over the current config, and compute which top-level sections now
need a restart. Pulling that into a service keeps the surface thin and
lets tests hit one place."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from docket.config.models import Config

RESTART_SECTIONS: frozenset[str] = frozenset(
    {"providers", "active_provider", "llm", "http", "sync"}
)
"""Top-level config keys that a live server can't hot-swap. Patching any of
these produces a `requires_restart` entry so the UI can prompt the user."""


_TOKEN_MASK_PREFIX = "••••••••"


class SettingsValidationError(ValueError):
    """Raised when a settings patch produces a Config that fails validation.

    Callers should map this to a 422-style response. We wrap `ValidationError`
    so surface code doesn't need to import pydantic."""

    def __init__(self, cause: ValidationError) -> None:
        super().__init__(f"Config validation failed: {cause}")
        self.cause = cause


@dataclass(frozen=True)
class PatchResult:
    """Outcome of `patch_settings`: the new Config and which sections were
    touched by the patch in a way that requires a restart to take effect."""

    config: Config
    requires_restart: list[str]


def mask_http_token(cfg: Config) -> dict[str, Any]:
    """Return a JSON-safe dict of `cfg` with `http.token` redacted.

    Used for every response that echoes current settings — the client should
    never see the full bearer token once it's been stored."""
    data = cfg.model_dump(mode="json")
    token = cfg.http.token
    if token:
        data.setdefault("http", {})["token"] = (
            _TOKEN_MASK_PREFIX + token[-4:] if len(token) > 4 else _TOKEN_MASK_PREFIX
        )
    else:
        data.setdefault("http", {})["token"] = ""
    return data


def patch_settings(current: Config, patch: dict[str, Any]) -> PatchResult:
    """Deep-merge `patch` over `current`, validate, and report restart-critical sections.

    If the client echoed back a masked token string, strip it so we don't overwrite
    the real value with bullets. Raises `SettingsValidationError` if the merged
    payload doesn't validate."""
    clean = _strip_masked_token(deepcopy(patch))
    base = current.model_dump(mode="json")
    merged_raw = _deep_merge(base, clean)
    try:
        merged = Config.model_validate(merged_raw)
    except ValidationError as e:
        raise SettingsValidationError(e) from e

    new_dump = merged.model_dump(mode="json")
    requires_restart = sorted(
        section
        for section in RESTART_SECTIONS
        if section in clean and base.get(section) != new_dump.get(section)
    )
    return PatchResult(config=merged, requires_restart=requires_restart)


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _deep_merge(out[key], value)
        else:
            out[key] = deepcopy(value)
    return out


def _strip_masked_token(patch: dict[str, Any]) -> dict[str, Any]:
    http_patch = patch.get("http")
    if not isinstance(http_patch, dict):
        return patch
    val = http_patch.get("token")
    if isinstance(val, str) and val.startswith(_TOKEN_MASK_PREFIX):
        http_patch.pop("token", None)
        if not http_patch:
            patch.pop("http", None)
    return patch


__all__ = [
    "RESTART_SECTIONS",
    "PatchResult",
    "SettingsValidationError",
    "mask_http_token",
    "patch_settings",
]
