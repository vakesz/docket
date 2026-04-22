from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.core import Item, ItemKind, ItemState, ScopeFilters, TransitionIntent
from docket.core.model import CreateFields
from docket.core.mutation import render_diff
from docket.core.services import mutation_service, sync_service
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.provider import FakeProvider


def _seed(tmp_path: Path) -> tuple:
    conn = init_db(tmp_path / "m.db")
    item = Item(
        id="42",
        kind=ItemKind.STORY,
        title="Ship it",
        description_md="# Old",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime(2026, 4, 21, 10, 0, tzinfo=UTC),
    )
    prov = FakeProvider(items=[item])
    sync_service.refresh(conn, prov, "default", ScopeFilters())
    return conn, prov


def test_propose_transition_requires_cached_item(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "m.db")
    with pytest.raises(KeyError):
        mutation_service.propose_transition(conn, "nope", TransitionIntent.START_WORK)


def test_dry_run_does_not_call_provider(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_transition(conn, "42", TransitionIntent.START_WORK)
    before = prov.items[0].state
    result = mutation_service.confirm(conn, prov, proposal, dry_run=True)
    assert result.dry_run is True
    assert prov.items[0].state is before  # unchanged


def test_transition_updates_provider_and_cache(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_transition(conn, "42", TransitionIntent.CLOSE_DONE)
    result = mutation_service.confirm(conn, prov, proposal)
    assert result.item is not None
    assert result.item.state is ItemState.CLOSED
    assert prov.items[0].state is ItemState.CLOSED
    cached = item_repo.get_item(conn, "42")
    assert cached and cached.state is ItemState.CLOSED


def test_description_patch_updates_cache(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_description_patch(conn, "42", "# New\nbody")
    # diff preview is rendered
    assert "# Old" in render_diff(proposal) or "# New" in render_diff(proposal)
    mutation_service.confirm(conn, prov, proposal)
    cached = item_repo.get_item(conn, "42")
    assert cached and cached.description_md == "# New\nbody"


def test_attachment_upload_records_attachment_and_returns_url(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_attachment(conn, "42", "convo-001.md", b"hi")
    result = mutation_service.confirm(conn, prov, proposal)
    assert result.attachment_url == "https://fake/attachments/convo-001.md"
    rows = conn.execute("SELECT filename, remote_url FROM attachments").fetchall()
    assert [tuple(r) for r in rows] == [("convo-001.md", "https://fake/attachments/convo-001.md")]
    assert prov.uploaded == [("42", "convo-001.md", b"hi")]


def test_create_item_upserts_into_cache(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    fields = CreateFields(title="New bug", description_md="repro steps", tags=["p0"])
    proposal = mutation_service.propose_create(ItemKind.BUG, fields)
    result = mutation_service.confirm(conn, prov, proposal)
    assert result.item is not None
    assert result.item.kind is ItemKind.BUG
    cached = item_repo.get_item(conn, result.item.id)
    assert cached and cached.title == "New bug"


def test_propose_comment_requires_cached_item(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "m.db")
    with pytest.raises(KeyError):
        mutation_service.propose_comment(conn, "missing", "hello")


def test_comment_add_writes_to_provider_and_refreshes_cache(tmp_path: Path) -> None:
    from docket.storage.repos import comment_repo

    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_comment(conn, "42", "Looks good to me.")
    diff = render_diff(proposal)
    assert "Looks good" in diff
    result = mutation_service.confirm(conn, prov, proposal)

    assert result.comment is not None
    assert result.comment.body_md == "Looks good to me."
    assert prov.comments["42"][-1].body_md == "Looks good to me."

    cached = comment_repo.list_comments(conn, "42")
    assert [c.body_md for c in cached] == ["Looks good to me."]


def test_comment_add_dry_run_does_not_call_provider(tmp_path: Path) -> None:
    conn, prov = _seed(tmp_path)
    proposal = mutation_service.propose_comment(conn, "42", "no-op")
    result = mutation_service.confirm(conn, prov, proposal, dry_run=True)
    assert result.dry_run is True
    assert result.comment is None
    assert prov.comments.get("42", []) == []
