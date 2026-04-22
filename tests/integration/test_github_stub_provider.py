"""Tests for the GitHub Issues stub provider.

These tests exist not to catch bugs in the stub itself (it's a trivial
in-memory impl) but to prove the abstraction: every TransitionIntent maps to
a legal GitHub state/reason pair, and the full `WorkItemProvider` Protocol
is satisfied structurally. If a future interface change breaks this stub
without breaking the Azure DevOps provider, that's a signal the abstraction leaked.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from docket.core.model import (
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    ScopeFilters,
    TransitionIntent,
)
from docket.core.services import mutation_service, sync_service
from docket.providers.base import WorkItemProvider
from docket.providers.github_stub import GitHubStubProvider
from docket.providers.github_stub.state_map import to_canonical, to_native
from docket.storage import init_db
from docket.storage.repos import item_repo


def _issue(
    id_: str = "example/repo#1",
    *,
    state: ItemState = ItemState.ACTIVE,
    updated: datetime | None = None,
) -> Item:
    return Item(
        id=id_,
        kind=ItemKind.BUG,
        title="Login crashes",
        description_md="Steps: ...",
        state=state,
        assignee=None,
        parent_id=None,
        updated_at=updated or datetime.now(UTC),
        url=f"https://github.example/{id_}",
        provider_raw={"github_state": "open", "github_state_reason": ""},
    )


def test_stub_satisfies_protocol() -> None:
    provider = GitHubStubProvider()
    # Runtime check — proves the Protocol's structural requirements are met.
    assert isinstance(provider, WorkItemProvider)


def test_every_intent_maps_to_legal_native_pair() -> None:
    for intent in TransitionIntent:
        native_state, native_reason = to_native(intent)
        assert native_state in {"open", "closed"}
        # Reason is only meaningful on closed/reopened; for open it may be
        # empty or "reopened".
        if native_state == "open":
            assert native_reason in {"", "reopened"}
        else:
            assert native_reason in {"completed", "not_planned"}


def test_canonical_roundtrips_for_known_pairs() -> None:
    assert to_canonical("open", "") == ItemState.ACTIVE
    assert to_canonical("open", "reopened") == ItemState.ACTIVE
    assert to_canonical("closed", "completed") == ItemState.RESOLVED
    assert to_canonical("closed", "not_planned") == ItemState.CLOSED
    # Unknown reason on closed → conservative CLOSED.
    assert to_canonical("closed", "🤷") == ItemState.CLOSED
    assert to_canonical("open", "weird-new-label") == ItemState.ACTIVE


def test_transition_updates_state_and_raw() -> None:
    issue = _issue()
    provider = GitHubStubProvider(issues=[issue])

    result = provider.transition(issue.id, TransitionIntent.CLOSE_DONE)
    assert result.state == ItemState.RESOLVED
    assert result.provider_raw["github_state"] == "closed"
    assert result.provider_raw["github_state_reason"] == "completed"

    reopened = provider.transition(issue.id, TransitionIntent.REOPEN)
    assert reopened.state == ItemState.ACTIVE
    assert reopened.provider_raw["github_state"] == "open"
    assert reopened.provider_raw["github_state_reason"] == "reopened"


def test_patch_description_advances_updated_at() -> None:
    issue = _issue()
    provider = GitHubStubProvider(issues=[issue])
    before = issue.updated_at
    result = provider.patch_description(issue.id, "new body")
    assert result.description_md == "new body"
    assert result.updated_at is not None
    assert before is not None and result.updated_at >= before


def test_create_item_assigns_numeric_id_in_repo() -> None:
    provider = GitHubStubProvider(default_repo="foo/bar")
    created = provider.create_item(
        ItemKind.TASK,
        CreateFields(title="new thing", description_md="body"),
    )
    assert created.id.startswith("foo/bar#")
    assert created.state == ItemState.ACTIVE  # GitHub opens in "open"
    assert created.provider_raw["github_state"] == "open"
    assert created.url is not None and "foo/bar" in created.url


def test_list_changes_since_respects_watermark() -> None:
    t0 = datetime(2026, 4, 20, 12, 0, tzinfo=UTC)
    t1 = t0 + timedelta(hours=1)
    old = _issue("example/repo#1", updated=t0)
    new = _issue("example/repo#2", updated=t1)
    provider = GitHubStubProvider(issues=[old, new])

    assert [i.id for i in provider.list_changes_since(None, ScopeFilters())] == [
        old.id,
        new.id,
    ]
    later = list(provider.list_changes_since(t0, ScopeFilters()))
    assert [i.id for i in later] == [new.id]


def test_sync_service_works_against_stub(tmp_path: Path) -> None:
    """The whole service-layer pipeline should run unchanged against a second
    provider. This is the load-bearing abstraction check."""
    conn = init_db(tmp_path / "docket.db")
    t = datetime(2026, 4, 21, 10, 0, tzinfo=UTC)
    provider = GitHubStubProvider(
        issues=[_issue("example/repo#7", updated=t)],
    )

    summary = sync_service.refresh(conn, provider, "default", ScopeFilters())
    assert summary.upserted == 1
    cached = item_repo.get_item(conn, "example/repo#7")
    assert cached is not None
    assert cached.state == ItemState.ACTIVE


def test_mutation_pipeline_works_against_stub(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    issue = _issue("example/repo#9")
    provider = GitHubStubProvider(issues=[issue])
    item_repo.upsert_item(conn, issue)

    proposal = mutation_service.propose_transition(conn, issue.id, TransitionIntent.CLOSE_DONE)
    result = mutation_service.confirm(conn, provider, proposal)
    assert result.item is not None and result.item.state == ItemState.RESOLVED
    # Cache was refreshed transparently.
    cached = item_repo.get_item(conn, issue.id)
    assert cached is not None and cached.state == ItemState.RESOLVED


def test_upload_attachment_records_call() -> None:
    provider = GitHubStubProvider(issues=[_issue()])
    url = provider.upload_attachment("example/repo#1", "convo-001.md", b"hello", "text/markdown")
    assert url.endswith("convo-001.md")
    assert provider.attachments == [("example/repo#1", "convo-001.md", b"hello")]


def test_get_item_raises_keyerror_on_unknown() -> None:
    provider = GitHubStubProvider()
    with pytest.raises(KeyError):
        provider.get_item("nope/nope#1")
