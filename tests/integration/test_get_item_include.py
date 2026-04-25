"""`get_item` fan-out tests.

The read-only `get_item` tool accepts `include=["comments", "linked"]` to
fetch related data in a single round. We cover the contract shape (payload
fields, error-per-bundle isolation, validation) rather than provider
fidelity, which lives in each provider's own suite.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from docket.agent.factory import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.model import Comment, Item, ItemKind, ItemState
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


def _fresh_conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "t.db")


def _item(id_: str = "S-1", **overrides: object) -> Item:
    base = dict(
        id=id_,
        kind=ItemKind.STORY,
        title=f"item {id_}",
        description_md="body",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime(2026, 4, 21, tzinfo=UTC),
        repository_url="https://github.com/acme/widgets",
    )
    base.update(overrides)
    return Item(**base)  # type: ignore[arg-type]


def _comment(item_id: str, body: str) -> Comment:
    return Comment(
        id=f"c-{item_id}",
        item_id=item_id,
        author="alice",
        body_md=body,
        created_at=datetime(2026, 4, 22, tzinfo=UTC),
    )


def test_get_item_surfaces_repository_url(tmp_path: Path) -> None:
    item = _item()
    provider = FakeProvider(items=[item])
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(registry.dispatch("get_item", {"id": "S-1"}))

    assert payload["repository_url"] == "https://github.com/acme/widgets"


def test_get_item_without_include_does_not_fan_out(tmp_path: Path) -> None:
    item = _item()
    provider = FakeProvider(items=[item], comments={"S-1": [_comment("S-1", "hi")]})
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(registry.dispatch("get_item", {"id": "S-1"}))

    assert "comments" not in payload
    assert "linked" not in payload


def test_get_item_include_comments(tmp_path: Path) -> None:
    item = _item()
    provider = FakeProvider(items=[item], comments={"S-1": [_comment("S-1", "hi")]})
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(registry.dispatch("get_item", {"id": "S-1", "include": ["comments"]}))

    assert payload["comments"] == [
        {
            "id": "c-S-1",
            "author": "alice",
            "created_at": "2026-04-22T00:00:00+00:00",
            "body_md": "hi",
        }
    ]
    assert "linked" not in payload


def test_get_item_include_linked(tmp_path: Path) -> None:
    """`linked` passes through to provider.get_linked, which FakeProvider
    returns as an empty list — the key is that the field is present."""
    item = _item()
    provider = FakeProvider(items=[item])
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(registry.dispatch("get_item", {"id": "S-1", "include": ["linked"]}))

    assert payload["linked"] == []


def test_get_item_include_errors_are_scoped_per_bundle(tmp_path: Path) -> None:
    """A failing `linked` lookup must NOT suppress a successful `comments`
    bundle — each gets its own `*_error` field and the item payload still
    returns."""

    class _BoomLinkedProvider(FakeProvider):
        def get_linked(self, id: str) -> list[Item]:
            raise RuntimeError("network down")

    item = _item()
    provider = _BoomLinkedProvider(items=[item], comments={"S-1": [_comment("S-1", "hi")]})
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(
        registry.dispatch("get_item", {"id": "S-1", "include": ["comments", "linked"]})
    )

    assert payload["id"] == "S-1"
    assert "comments" in payload
    assert "linked_error" in payload
    assert "network down" in payload["linked_error"]


def test_get_item_rejects_unknown_include_token(tmp_path: Path) -> None:
    item = _item()
    provider = FakeProvider(items=[item])
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=provider)

    payload = json.loads(registry.dispatch("get_item", {"id": "S-1", "include": ["bogus"]}))

    assert "error" in payload
    assert "comments" in payload["error"]  # lists allowed values
