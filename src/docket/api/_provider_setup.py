"""Shared building blocks for `setup.py` and `settings.py` provider routes.

The two route modules expose nearly-identical surfaces — the only practical
difference is which token guards them (setup token in bootstrap mode,
bearer token in live mode). Centralizing the DTO assembly, draft test, and
config-dump-then-persist pattern keeps them from drifting field-by-field.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from docket.api.runtime import RuntimeState
from docket.api.schemas import (
    SetupProviderFieldDTO,
    SetupProviderTypeDTO,
    SetupTestResultDTO,
)
from docket.config.loader import save_config
from docket.config.models import Config, ProviderEntry, ScopeFilter, build_provider_entry
from docket.config.paths import Paths
from docket.providers import registry
from docket.providers.base import ProviderError, WorkItemProvider
from docket.providers.registry import UnknownProviderError
from docket.providers.registry import build as build_provider
from docket.providers.registry import specs as provider_specs


def provider_type_dtos() -> list[SetupProviderTypeDTO]:
    """Snapshot the registry as DTOs for `/setup/providers/types` and `/settings/providers/types`."""
    return [
        SetupProviderTypeDTO(
            id=spec.type_id,
            display=spec.display_name,
            requires_cli=list(spec.requires_cli),
            fields=[
                SetupProviderFieldDTO(
                    key=f.key,
                    label=f.label,
                    kind=f.kind,
                    required=f.required,
                    placeholder=f.placeholder,
                    help=f.help,
                )
                for f in spec.setup_fields
            ],
        )
        for spec in provider_specs()
    ]


def test_provider_draft(type_id: str, config: dict[str, Any]) -> SetupTestResultDTO:
    """Dry-run a provider config without persisting it.

    Returns `ok=True` only when the provider builds AND its health check
    passes. Both the bootstrap (`/setup/test-provider`) and authenticated
    (`/settings/providers/test`) endpoints share this body."""
    try:
        provider = build_provider(type_id, dict(config), display_name=type_id)
    except UnknownProviderError as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    except (ValueError, ValidationError) as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    try:
        provider.health_check()
    except ProviderError as e:
        return SetupTestResultDTO(ok=False, error=str(e))
    except Exception as e:
        return SetupTestResultDTO(ok=False, error=f"{type(e).__name__}: {e}")
    return SetupTestResultDTO(ok=True)


def build_and_validate_provider_entry(
    *,
    key: str,
    type_id: str,
    display_name: str | None,
    config: dict[str, Any],
    scope: dict[str, Any],
    existing: ProviderEntry | None = None,
) -> tuple[ProviderEntry, WorkItemProvider]:
    """Normalize + validate a provider draft and return the persistable entry.

    Wraps the four-step recipe shared by `/setup/complete`,
    `/settings/providers` (POST), and `/settings/providers/{key}` (PUT):

    1. `registry.normalize_config` — canonicalize fields the spec opts in to.
    2. `registry.build` — instantiate the provider so we know the credentials
       work syntactically before we persist anything.
    3. `ScopeFilter(**scope)` — validate the scope filter shape.
    4. `build_provider_entry` — assemble the final `ProviderEntry`,
       optionally merging an `existing` entry's extra scope slots.

    Returns `(entry, built_provider)` so the caller can both write the entry
    to config and swap the live runtime instance. Raises `HTTPException(422)`
    with a stable detail format on any validation error so route handlers
    don't repeat the boilerplate."""
    resolved_name = display_name or key
    try:
        normalized = registry.normalize_config(type_id, dict(config))
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except ValueError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid config for '{key}': {e}",
        ) from e

    try:
        built = build_provider(type_id, dict(normalized), display_name=resolved_name)
    except UnknownProviderError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    except (ValueError, ValidationError) as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid config for '{key}': {e}",
        ) from e

    try:
        scope_filter = ScopeFilter(**dict(scope))
    except ValidationError as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"invalid scope for '{key}': {e}",
        ) from e

    entry = build_provider_entry(
        type_id=type_id,
        display_name=resolved_name,
        config=normalized,
        scope=scope_filter,
        existing=existing,
    )
    return entry, built


def persist_config_change(
    runtime: RuntimeState,
    paths: Paths,
    mutate: Callable[[dict[str, Any]], None],
    *,
    on_error: str = "Config validation failed",
    error_status: int = status.HTTP_422_UNPROCESSABLE_CONTENT,
) -> Config:
    """Apply `mutate` to a JSON dump of the live config, validate, persist, swap.

    The four-step "dump → mutate → validate → save → reassign" dance appears
    in every settings route that touches `runtime.config`. Centralizing keeps
    the validation status code and the in-memory swap consistent — forgetting
    the swap would leave `runtime.config` stale until a restart."""
    cfg_dump = runtime.config.model_dump(mode="json")
    mutate(cfg_dump)
    try:
        merged = Config.model_validate(cfg_dump)
    except ValidationError as e:
        raise HTTPException(error_status, f"{on_error}: {e}") from e
    save_config(paths, merged)
    runtime.config = merged
    return merged


__all__ = [
    "build_and_validate_provider_entry",
    "persist_config_change",
    "provider_type_dtos",
    "test_provider_draft",
]
