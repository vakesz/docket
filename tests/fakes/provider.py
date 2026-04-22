from __future__ import annotations

import itertools
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    ScopeFilters,
    TransitionIntent,
)

# Simple in-memory canonical-state transition logic mirroring the ADO Agile plan,
# minus provider-specific tag bookkeeping. Good enough for exercising the mutation
# pipeline end-to-end in tests.
_STATE_BY_INTENT: dict[TransitionIntent, ItemState] = {
    TransitionIntent.START_WORK: ItemState.ACTIVE,
    TransitionIntent.PAUSE: ItemState.NEW,
    TransitionIntent.BLOCK: ItemState.BLOCKED,
    TransitionIntent.NEEDS_INFO: ItemState.NEEDS_INFO,
    TransitionIntent.CLOSE_DONE: ItemState.CLOSED,
    TransitionIntent.CLOSE_WONTFIX: ItemState.CLOSED,
    TransitionIntent.REOPEN: ItemState.ACTIVE,
}


@dataclass
class FakeProvider:
    """In-memory WorkItemProvider for tests. Satisfies the structural protocol."""

    items: list[Item] = field(default_factory=list)
    comments: dict[str, list[Comment]] = field(default_factory=dict)
    uploaded: list[tuple[str, str, bytes]] = field(default_factory=list)
    list_calls: list[datetime | None] = field(default_factory=list)
    _id_seq: itertools.count[int] = field(default_factory=lambda: itertools.count(1000))

    # -- reads ---------------------------------------------------------------

    def health_check(self) -> None:
        pass

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        self.list_calls.append(watermark)
        if watermark is None:
            return list(self.items)
        return [i for i in self.items if i.updated_at and i.updated_at > watermark]

    def get_item(self, id: str) -> Item:
        for i in self.items:
            if i.id == id:
                return i
        raise KeyError(id)

    def get_comments(self, id: str) -> list[Comment]:
        return list(self.comments.get(id, []))

    def get_linked(self, id: str) -> list[Item]:
        return []

    # -- writes --------------------------------------------------------------

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        current = self.get_item(id)
        new_state = _STATE_BY_INTENT[intent]
        updated = Item(
            id=current.id,
            kind=current.kind,
            title=current.title,
            description_md=current.description_md,
            state=new_state,
            assignee=current.assignee,
            parent_id=current.parent_id,
            tags=list(current.tags),
            updated_at=datetime.now(UTC),
            url=current.url,
            provider_raw={**current.provider_raw, "ado_state": new_state.value},
        )
        self._replace(updated)
        return updated

    def patch_description(self, id: str, new_md: str) -> Item:
        current = self.get_item(id)
        updated = Item(
            id=current.id,
            kind=current.kind,
            title=current.title,
            description_md=new_md,
            state=current.state,
            assignee=current.assignee,
            parent_id=current.parent_id,
            tags=list(current.tags),
            updated_at=datetime.now(UTC),
            url=current.url,
            provider_raw=dict(current.provider_raw),
        )
        self._replace(updated)
        return updated

    def upload_attachment(self, id: str, filename: str, content: bytes, content_type: str) -> str:
        self.uploaded.append((id, filename, content))
        return f"https://fake/attachments/{filename}"

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        new_id = str(next(self._id_seq))
        item = Item(
            id=new_id,
            kind=kind,
            title=fields.title,
            description_md=fields.description_md,
            state=ItemState.NEW,
            assignee=fields.assignee,
            parent_id=fields.parent_id,
            tags=list(fields.tags),
            updated_at=datetime.now(UTC),
        )
        self.items.append(item)
        return item

    # -- helpers -------------------------------------------------------------

    def _replace(self, item: Item) -> None:
        self.items = [item if i.id == item.id else i for i in self.items]
