from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
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

    # Optional: returning the authenticated user's identity — the string that
    # the provider stamps into `Item.assignee` for "me" — lets the surface-
    # level `@me` visual filter match cached rows. Providers that can't
    # resolve their own identity cheaply can omit this; `@me` then degrades
    # to "no filter" (everything the user can see).
    def current_user_identity(self) -> str | None: ...


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

ProviderConfigNormalizer = Callable[[dict[str, Any]], dict[str, Any]]
"""Normalizer called before a provider config is validated and persisted.

Receives the raw wizard/API input and returns a cleaned dict (strip whitespace,
canonicalize URLs, fill template defaults). Raise `ValueError` with a
human-readable message on invalid input; the HTTP/CLI surfaces will relay it."""


LabelTemplate = Callable[[Mapping[str, Any]], str]
"""Build a human-readable display name from a provider's config dict.

Used as the default for the display-name prompt in the first-run wizard, in
`docket setup provider add`, and in the SPA's suggest-label endpoint. The
template reads only what's already in `config` (e.g. `base_url`,
`default_repo`, `organization`) — no out-of-band hints — so any surface that
calls it sees the same result for the same config.

Return an empty string when no useful label can be inferred; callers fall
back to the provider's `display_name` or the bare type id."""


GroupingStrategy = Literal["by_kind", "by_state_bucket"]
"""How the TUI's backlog tree should group items for this provider.

- `"by_kind"` — top-level buckets follow `ItemKind` (Epic/Feature/Story/Task/
  Bug) with parent/child nesting inside. Matches Azure DevOps, which uses a
  real hierarchy and labels all five kinds.
- `"by_state_bucket"` — top-level buckets are Open vs Done. Matches GitHub
  Issues, which only realistically emit TASK/STORY/BUG and have no
  Epic/Feature hierarchy to group under.
"""


_ALL_KINDS: tuple[ItemKind, ...] = tuple(ItemKind)


@dataclass(frozen=True)
class ProviderSpec:
    """Static description of a provider type — what the registry knows about it.

    `factory` constructs a live provider from `(config, display_name)`.
    `setup_fields` and `requires_cli` are consumed by the setup surfaces
    (HTTP `/setup/providers/types`, CLI `docket setup provider add`) so each
    provider owns the shape of its own onboarding.

    `grouping` tells the TUI how to arrange the backlog tree — see
    `GroupingStrategy`. Defaulting to `"by_kind"` keeps the existing Azure
    DevOps behavior for any spec that doesn't explicitly opt in.

    `supported_kinds` is the ordered set of kinds this provider can create.
    Surfaces render it as the choices in the new-item picker; it does not gate
    reads (cached items already carry a translated `ItemKind`). Defaults to all
    canonical kinds so non-overriding specs keep full-range behavior."""

    type_id: str
    display_name: str
    factory: ProviderFactory
    setup_fields: tuple[SetupField, ...] = field(default_factory=tuple)
    requires_cli: tuple[str, ...] = field(default_factory=tuple)
    grouping: GroupingStrategy = "by_kind"
    supported_kinds: tuple[ItemKind, ...] = _ALL_KINDS
    normalize_config: ProviderConfigNormalizer | None = None
    label_template: LabelTemplate | None = None
