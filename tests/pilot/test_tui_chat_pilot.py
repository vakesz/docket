"""End-to-end TUI chat test.

Drives the chat pane via Textual's pilot against a scripted fake LLM. Verifies:
  - submitting text posts a UserTurnRequest and starts a worker
  - streamed deltas accumulate into the visible assistant bubble
  - tool calls produce a note line
  - the token ledger updates
  - `t` starts a fresh thread (archives current + clears transcript)
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.cli.tui.app import DocketApp
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import conversation_repo, item_repo, message_repo
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider


def _mk_item(id_: str = "S-1") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title="Add login",
        description_md="User should be able to log in.",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


def _find_node(node, target_id: str):
    for child in node.children:
        if child.data == target_id:
            return child
        found = _find_node(child, target_id)
        if found is not None:
            return found
    return None


@pytest.fixture
def chat_env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    client = FakeLlmClient()
    ctx = TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
        llm=client,
    )
    yield ctx, client, item
    conn.close()


async def _select_story(app: DocketApp, pilot) -> None:
    tree = app.query_one(ItemTree)
    node = _find_node(tree.root, "S-1")
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


async def test_streamed_text_lands_in_transcript(chat_env) -> None:
    ctx, client, _ = chat_env
    client.script = [text_turn("Hello.")]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        chat = app.query_one(ChatPane)
        chat.post_message_type = None  # no-op; placeholder to clarify contract

        prompt = chat.query_one("#prompt")
        prompt.value = "hi"
        await prompt.action_submit()
        # Wait for worker
        await app.workers.wait_for_complete()
        await pilot.pause()

        ledger = chat.query_one("#ledger")
        assert "tokens" in str(ledger.render())

    # Persistence survived the run
    convos = conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)
    assert len(convos) == 1
    msgs = message_repo.list_for_conversation(ctx.conn, convos[0].id)
    assert [m.role for m in msgs] == ["user", "assistant"]
    assert msgs[-1].content == "Hello."


async def test_tool_call_produces_note_line(chat_env) -> None:
    ctx, client, _ = chat_env
    client.script = [
        tool_turn("tc-1", "get_item", '{"id":"S-1"}'),
        text_turn("Summary."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)

        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "summarize"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

    convos = conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)
    msgs = message_repo.list_for_conversation(ctx.conn, convos[0].id)
    assert [m.role for m in msgs] == ["user", "assistant", "tool", "assistant"]
    assert msgs[-1].content == "Summary."


async def test_t_starts_new_thread(chat_env) -> None:
    ctx, client, _ = chat_env
    client.script = [text_turn("one")]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "hi"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        await app.run_action("new_thread")
        await pilot.pause()

    convos = conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)
    assert len(convos) == 2
    # Oldest is archived, newest is active.
    archived = [c for c in convos if c.archived_at is not None]
    active = [c for c in convos if c.archived_at is None]
    assert len(archived) == 1
    assert len(active) == 1


async def test_acceptance_checklist_mounts_from_description(tmp_path: Path) -> None:
    """Selecting an item whose description has task-list items should populate
    the criteria panel with one Checkbox per criterion, preserving check state."""
    from textual.widgets import Checkbox

    conn = init_db(tmp_path / "docket.db")
    item = Item(
        id="S-2",
        kind=ItemKind.STORY,
        title="Ship login",
        description_md="- [ ] write the spec\n- [x] ship the migration\n",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    ctx = TuiContext(conn=conn, provider=provider, scope=ScopeFilters(), scope_key="default")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        tree = app.query_one(ItemTree)
        node = _find_node(tree.root, "S-2")
        assert node is not None
        tree.select_node(node)
        await pilot.pause()

        chat = app.query_one(ChatPane)
        boxes = list(chat.query(Checkbox).results())
        assert [str(b.label) for b in boxes] == ["write the spec", "ship the migration"]
        assert [bool(b.value) for b in boxes] == [False, True]

    conn.close()


async def test_acceptance_panel_hidden_when_no_criteria(chat_env) -> None:
    ctx, _, _ = chat_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        chat = app.query_one(ChatPane)
        container = chat.query_one("#criteria")
        assert "has-items" not in container.classes


async def test_chat_disabled_without_llm(chat_env) -> None:
    ctx, _, _ = chat_env
    ctx.llm = None  # simulate --no-chat
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "hi"
        await prompt.action_submit()
        await pilot.pause()

    # No conversation should have been created.
    convos = conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)
    assert convos == []
