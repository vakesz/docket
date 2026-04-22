from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol, runtime_checkable

from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ScopeFilters,
    TransitionIntent,
)


class ProviderError(Exception):
    """Base class for provider-layer errors surfaced to core."""


class ProviderUnreachableError(ProviderError):
    """Remote system is unreachable. Per plan §13, we fail fast — do not silently degrade."""


class ProviderAuthError(ProviderError):
    """Credentials are missing or rejected. Wizard should re-run the relevant step."""


@runtime_checkable
class WorkItemProvider(Protocol):
    """Provider-agnostic interface for work-item systems (Azure DevOps first; Jira/GitHub later).

    All canonical-model instances returned from here have provider-specific state strings
    already translated into ItemState. Providers MUST NOT leak raw provider state through
    this interface — that's what `Item.provider_raw` is for.
    """

    def health_check(self) -> None: ...

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]: ...

    def get_item(self, id: str) -> Item: ...

    def get_comments(self, id: str) -> list[Comment]: ...

    def get_linked(self, id: str) -> list[Item]: ...

    def transition(self, id: str, intent: TransitionIntent) -> Item: ...

    def patch_description(self, id: str, new_md: str) -> Item: ...

    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str: ...

    def add_comment(self, id: str, body_md: str) -> Comment: ...

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item: ...


@dataclass(frozen=True)
class SetupField:
    """One config field a provider asks the first-time wizard to collect.

    `kind="url"` gets a URL validator in the frontend; `kind="secret"` is
    write-only and masked on display. All other fields are plain strings."""

    key: str
    label: str
    kind: Literal["string", "url", "secret"] = "string"
    required: bool = True
    placeholder: str = ""
    help: str = ""


ProviderFactory = Callable[[dict[str, Any], str], WorkItemProvider]


@dataclass(frozen=True)
class ProviderSpec:
    """Static description of a provider type — what the registry knows about it.

    `factory` constructs a live provider from `(config, display_name)`.
    `setup_fields` and `requires_cli` are consumed by the setup surfaces
    (HTTP `/setup/providers/types`, CLI `docket setup provider add`) so each
    provider owns the shape of its own onboarding."""

    type_id: str
    display_name: str
    factory: ProviderFactory
    setup_fields: tuple[SetupField, ...] = field(default_factory=tuple)
    requires_cli: tuple[str, ...] = field(default_factory=tuple)
