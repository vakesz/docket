from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any


class ItemKind(StrEnum):
    EPIC = "epic"
    FEATURE = "feature"
    STORY = "story"
    TASK = "task"
    BUG = "bug"


class ItemState(StrEnum):
    NEW = "new"
    ACTIVE = "active"
    BLOCKED = "blocked"
    NEEDS_INFO = "needs_info"
    RESOLVED = "resolved"
    CLOSED = "closed"


class TransitionIntent(StrEnum):
    START_WORK = "start_work"
    PAUSE = "pause"
    BLOCK = "block"
    NEEDS_INFO = "needs_info"
    CLOSE_DONE = "close_done"
    CLOSE_WONTFIX = "close_wontfix"
    REOPEN = "reopen"


@dataclass(frozen=True)
class ScopeFilters:
    """Visual filter applied to cached items — *not* to provider queries.

    Sync always pulls every item a provider exposes (so child items of
    something assigned to the user are still in the cache). These fields
    narrow the view at render time: the TUI list, CLI `list`, and HTTP
    `/items` apply them post-cache. Empty string means "don't filter on
    this axis"; assignee `"@me"` means the cached `assignee` column must
    match the provider's current-user identity (empty string is taken as
    "any" in line with the config default)."""

    team: str = ""
    area_path: str = ""
    iteration_path: str = ""
    assignee: str = "@me"


@dataclass(frozen=True)
class Attachment:
    filename: str
    url: str | None = None


@dataclass
class Item:
    id: str
    kind: ItemKind
    title: str
    description_md: str
    state: ItemState
    assignee: str | None
    parent_id: str | None
    tags: list[str] = field(default_factory=list)
    updated_at: datetime | None = None
    url: str | None = None
    author: str | None = None
    # Repository the item is primarily associated with, when the provider can
    # attest to it (GitHub knows; Azure DevOps generally doesn't surface a
    # reliable repo pointer in a work item's payload, so it stays None there).
    repository_url: str | None = None
    attachments: list[Attachment] = field(default_factory=list)
    provider_raw: dict[str, Any] = field(default_factory=dict)
    # Stamped at the storage boundary (sync_service + mutation upserts) so the
    # shared items cache can be filtered to the active provider. Defaults to
    # "" for unit tests and in-memory construction; real code always stamps it.
    provider_key: str = ""


@dataclass
class Comment:
    id: str
    item_id: str
    author: str
    body_md: str
    created_at: datetime


@dataclass
class Conversation:
    id: str
    item_id: str
    started_at: datetime
    archived_at: datetime | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_cents: int = 0


@dataclass
class Message:
    id: str
    conversation_id: str
    role: str
    content: str
    tool_calls: list[dict[str, Any]] | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    created_at: datetime | None = None


@dataclass
class CreateFields:
    title: str
    description_md: str = ""
    parent_id: str | None = None
    assignee: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class SyncSummary:
    upserted: int
    archived: int
    watermark: datetime | None


@dataclass(frozen=True)
class PRMatch:
    """A pull request that might be related to a work item.

    Returned by `WorkItemProvider.find_related_prs`. `confidence` is a soft
    hint (0.0-1.0) the provider attaches based on how strong the signal was
    — direct id mention in title > mention in body > keyword overlap. The
    agent uses it to decide whether a match is worth surfacing as a
    link-back proposal."""

    url: str
    title: str
    branch: str = ""
    state: str = ""  # "open" | "merged" | "closed" — provider-specific labels OK
    author: str = ""
    confidence: float = 0.5


@dataclass
class Project:
    """A named provider. The id is `provider_key` — memory, sources,
    sub-agents, and MCP servers are keyed by provider, not by scope.

    Scopes live on the provider as visual filters: switching scope in the
    TUI re-filters what's shown from the cache but keeps the same project
    context (same memory, same sources, same MCP fleet). This matters
    because items assigned to the user can link to items assigned to
    someone else — both belong in the same project."""

    id: str
    provider_key: str
    name: str
    description: str = ""
    created_at: datetime | None = None
    archived_at: datetime | None = None


@dataclass
class MemoryEntry:
    """A single per-project memory note.

    Memory is the agent's durable knowledge of a project (glossary terms,
    design decisions, conventions). Bodies are plain Markdown so a human
    can read and edit them. `source` distinguishes user-authored ("user")
    from agent-staged-and-confirmed ("agent") entries — both are equally
    durable, the field is just informational."""

    id: str
    project_id: str
    title: str
    body_md: str
    tags: list[str] = field(default_factory=list)
    source: str = "user"
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class Source:
    """A single per-project reference document.

    Sources are human-curated long-form material the agent can read on
    demand (requirements, runbooks, design docs). The agent has read-only
    access — there is no `propose_source_*` flow. `kind` is free-text
    ("requirements", "runbook", …) and `uri` is optional metadata; neither
    is interpreted by docket itself."""

    id: str
    project_id: str
    title: str
    body_md: str
    kind: str = ""
    uri: str = ""
    tags: list[str] = field(default_factory=list)
    created_at: datetime | None = None
    updated_at: datetime | None = None


def project_id_for(provider_key: str) -> str:
    """Deterministic project id — just the provider key.

    A project IS a provider: memory, sources, sub-agents, and MCP servers
    live per-provider and are shared across every scope (view). Scopes are
    visual filters applied at query time, so they don't split project
    identity. Empty `provider_key` is allowed for tests and for the
    implicit "no provider configured yet" case."""
    return provider_key
