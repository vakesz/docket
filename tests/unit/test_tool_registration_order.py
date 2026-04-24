"""Pin the agent tool registration order.

Tool schemas are part of the prompt prefix — reordering invalidates the
prompt cache for every open conversation. This test locks the order for
the four common build configurations so refactors to `factory.py`,
`tool_defs.py`, `memory_tools.py`, or `source_tools.py` can't silently
drift the sequence. When the diff looks intentional, update the expected
lists AND (usually) flush the prompt cache by bumping the relevant
template's mtime."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from docket.agent.factory import build_tool_registry
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


@pytest.fixture
def conn() -> Iterator[object]:
    with TemporaryDirectory() as td:
        yield init_db(Path(td) / "x.sqlite")


def _names(
    conn: object,
    *,
    read_only: bool,
    project_id: str,
) -> list[str]:
    registry = build_tool_registry(
        conn=conn,  # type: ignore[arg-type]
        provider=FakeProvider(),
        store=ProposalStore(),
        active_item=lambda: None,
        read_only=read_only,
        provider_key="primary",
        project_id=project_id,
        mcp_manager=None,
    )
    return [schema.name for schema in registry.schemas()]


def test_read_only_no_project(conn: object) -> None:
    assert _names(conn, read_only=True, project_id="") == [
        "get_item",
        "get_comments",
        "get_linked_items",
        "search_items",
    ]


def test_read_only_with_project(conn: object) -> None:
    assert _names(conn, read_only=True, project_id="primary") == [
        "get_item",
        "get_comments",
        "get_linked_items",
        "search_items",
        "list_memory",
        "recall_memory",
        "list_sources",
        "read_source",
        "search_sources",
    ]


def test_read_write_no_project(conn: object) -> None:
    assert _names(conn, read_only=False, project_id="") == [
        "get_item",
        "get_comments",
        "get_linked_items",
        "search_items",
        "propose_transition",
        "propose_description_patch",
        "propose_new_item",
        "attach_transcript",
        "propose_comment",
    ]


def test_read_write_with_project(conn: object) -> None:
    """Full surface: RO provider, RO project (memory + sources), then RW
    provider, then RW memory. The docstring on `build_tool_registry`
    describes this sequence; any change here should match that docstring
    (and be deliberate — prompt cache invalidation follows)."""
    assert _names(conn, read_only=False, project_id="primary") == [
        "get_item",
        "get_comments",
        "get_linked_items",
        "search_items",
        "list_memory",
        "recall_memory",
        "list_sources",
        "read_source",
        "search_sources",
        "propose_transition",
        "propose_description_patch",
        "propose_new_item",
        "attach_transcript",
        "propose_comment",
        "propose_memory_write",
        "propose_memory_delete",
    ]
