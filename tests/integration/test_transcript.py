from __future__ import annotations

import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.agent.transcript import filename_for, next_version, render_markdown
from docket.agent.types import ChatMessage, ToolCall
from docket.core.model import Item, ItemKind, ItemState
from docket.storage import init_db
from docket.storage.repos import item_repo


def _mk_item(id_: str = "S-1") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title="Login flow",
        description_md="x",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def conn(tmp_path: Path):
    c = init_db(tmp_path / "t.db")
    item_repo.upsert_item(c, _mk_item())
    yield c
    c.close()


def _insert_attachment(conn, item_id: str, filename: str) -> None:
    conn.execute(
        "INSERT INTO attachments (id, item_id, conversation_id, filename, remote_url, uploaded_at) "
        "VALUES (?, ?, NULL, ?, ?, ?)",
        (
            str(uuid.uuid4()),
            item_id,
            filename,
            f"https://fake/{filename}",
            datetime.now(UTC).isoformat(),
        ),
    )


def test_filename_format() -> None:
    assert filename_for(1) == "convo-001.md"
    assert filename_for(42) == "convo-042.md"
    assert filename_for(999) == "convo-999.md"


def test_next_version_when_empty_is_one(conn) -> None:
    assert next_version(conn, "S-1") == 1


def test_next_version_increments_past_existing_uploads(conn) -> None:
    _insert_attachment(conn, "S-1", "convo-001.md")
    _insert_attachment(conn, "S-1", "convo-002.md")
    assert next_version(conn, "S-1") == 3


def test_next_version_respects_out_of_band_uploads(conn) -> None:
    # Someone uploaded convo-005.md out-of-band; we must not collide.
    _insert_attachment(conn, "S-1", "convo-005.md")
    assert next_version(conn, "S-1") == 6


def test_next_version_ignores_non_matching_filenames(conn) -> None:
    _insert_attachment(conn, "S-1", "diagram.png")
    _insert_attachment(conn, "S-1", "convo-3.md")  # too few digits — ignored
    _insert_attachment(conn, "S-1", "convo-001.md")
    assert next_version(conn, "S-1") == 2


def test_next_version_is_per_item(conn) -> None:
    item_repo.upsert_item(conn, _mk_item("S-2"))
    _insert_attachment(conn, "S-1", "convo-001.md")
    _insert_attachment(conn, "S-1", "convo-002.md")
    assert next_version(conn, "S-2") == 1


def test_render_markdown_includes_header_and_user_and_assistant() -> None:
    started = datetime(2026, 4, 21, 10, 30, tzinfo=UTC)
    messages = [
        ChatMessage(role="user", content="Can you start work on this?"),
        ChatMessage(
            role="assistant",
            content="I'll stage a transition now.",
            tool_calls=[
                ToolCall(
                    id="c1",
                    name="propose_transition",
                    arguments={"id": "S-1", "intent": "start_work"},
                )
            ],
        ),
        ChatMessage(
            role="tool",
            content='{"status":"pending_confirmation"}',
            tool_call_id="c1",
            name="propose_transition",
        ),
    ]
    md = render_markdown(
        item_id="S-1",
        item_title="Login flow",
        messages=messages,
        started_at=started,
    )
    assert "# Conversation transcript" in md
    assert "S-1 — Login flow" in md
    assert "2026-04-21T10:30:00+00:00" in md
    assert "## You" in md
    assert "Can you start work on this?" in md
    assert "## Assistant" in md
    assert "I'll stage a transition now." in md
    assert "called `propose_transition`" in md
    assert "`propose_transition` returned" in md
    assert "pending_confirmation" in md


def test_render_markdown_omits_system_messages() -> None:
    messages = [
        ChatMessage(role="system", content="secret prefix"),
        ChatMessage(role="user", content="hi"),
    ]
    md = render_markdown(item_id="S-1", item_title="t", messages=messages)
    assert "secret prefix" not in md
    assert "hi" in md


def test_render_markdown_truncates_long_tool_output() -> None:
    long_blob = "x" * 2000
    messages = [
        ChatMessage(role="tool", content=long_blob, tool_call_id="c1", name="search_items"),
    ]
    md = render_markdown(item_id="S-1", item_title="t", messages=messages)
    # Truncation cap is 800 chars + the " …" suffix.
    assert "xxx …" in md
    assert long_blob not in md
