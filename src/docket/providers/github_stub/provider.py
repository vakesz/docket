"""In-memory GitHub Issues stub provider.

Satisfies `WorkItemProvider` without network access. Useful for:

- Demos and docs that need a second backend.
- Cross-provider integration tests — the same service-layer code paths run
  against ADO and this stub unchanged.
- Bootstrapping a real GitHub provider: swap `_issues`/`_comments` for REST
  calls (`/repos/{owner}/{repo}/issues`) and keep everything else identical.

Items are stored in a dict keyed by `id`, which for GitHub is
`"{owner}/{repo}#{number}"` by convention. Seed data is optional.
"""
from __future__ import annotations

import itertools
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    ScopeFilters,
    TransitionIntent,
)
from docket.providers.github_stub.state_map import to_canonical, to_native


@dataclass
class GitHubStubProvider:
    """`WorkItemProvider`-compatible in-memory GitHub Issues fake."""

    default_repo: str = "example/repo"
    issues: list[Item] = field(default_factory=list)
    comments: dict[str, list[Comment]] = field(default_factory=dict)
    attachments: list[tuple[str, str, bytes]] = field(default_factory=list)
    _id_seq: itertools.count[int] = field(default_factory=lambda: itertools.count(1))

    # -- reads ---------------------------------------------------------------

    def health_check(self) -> None:
        """Stubs are always reachable."""
        return None

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        if watermark is None:
            return list(self.issues)
        return [i for i in self.issues if i.updated_at and i.updated_at > watermark]

    def get_item(self, id: str) -> Item:
        for issue in self.issues:
            if issue.id == id:
                return issue
        raise KeyError(id)

    def get_comments(self, id: str) -> list[Comment]:
        return list(self.comments.get(id, []))

    def get_linked(self, id: str) -> list[Item]:
        """GitHub has no first-class parent/child linkage in the REST API —
        real implementations typically scan `tracked_issues`/`closes` in the
        body. The stub returns an empty list; that's fine for the abstraction
        check."""
        return []

    # -- writes --------------------------------------------------------------

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        current = self.get_item(id)
        native_state, native_reason = to_native(intent)
        new_raw = {
            **current.provider_raw,
            "github_state": native_state,
            "github_state_reason": native_reason,
        }
        updated = Item(
            id=current.id,
            kind=current.kind,
            title=current.title,
            description_md=current.description_md,
            state=to_canonical(native_state, native_reason),
            assignee=current.assignee,
            parent_id=current.parent_id,
            tags=list(current.tags),
            updated_at=datetime.now(UTC),
            url=current.url,
            provider_raw=new_raw,
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

    def upload_attachment(
        self, id: str, filename: str, content: bytes, content_type: str
    ) -> str:
        # GitHub REST doesn't support direct attachment upload — real
        # implementations typically post a comment with a pre-signed URL.
        # For the stub we just record the call and return a synthetic URL.
        _ = content_type
        self.attachments.append((id, filename, content))
        return f"https://github.example/attachments/{id}/{filename}"

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        number = next(self._id_seq)
        issue_id = f"{self.default_repo}#{number}"
        raw: dict[str, Any] = {
            "github_state": "open",
            "github_state_reason": "",
            "number": number,
        }
        item = Item(
            id=issue_id,
            kind=kind,
            title=fields.title,
            description_md=fields.description_md,
            state=ItemState.ACTIVE,  # GitHub issues open in ACTIVE, not NEW
            assignee=fields.assignee,
            parent_id=fields.parent_id,
            tags=list(fields.tags),
            updated_at=datetime.now(UTC),
            url=f"https://github.example/{self.default_repo}/issues/{number}",
            provider_raw=raw,
        )
        self.issues.append(item)
        return item

    # -- helpers -------------------------------------------------------------

    def _replace(self, item: Item) -> None:
        self.issues = [item if i.id == item.id else i for i in self.issues]


__all__ = ["GitHubStubProvider"]
