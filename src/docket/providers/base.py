from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Protocol, runtime_checkable

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
    """Provider-agnostic interface for work-item systems (ADO first; Jira/GitHub later).

    All canonical-model instances returned from here have provider-specific state strings
    already translated into ItemState. Providers MUST NOT leak raw provider state through
    this interface — that's what `Item.provider_raw` is for.
    """

    def health_check(self) -> None:
        ...

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        ...

    def get_item(self, id: str) -> Item:
        ...

    def get_comments(self, id: str) -> list[Comment]:
        ...

    def get_linked(self, id: str) -> list[Item]:
        ...

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        ...

    def patch_description(self, id: str, new_md: str) -> Item:
        ...

    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str:
        ...

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        ...
