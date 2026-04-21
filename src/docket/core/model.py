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
    """Filters applied to provider queries; mirrors the ScopeFilter config model
    but lives in core so providers depend only on core."""

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
    attachments: list[Attachment] = field(default_factory=list)
    provider_raw: dict[str, Any] = field(default_factory=dict)


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
