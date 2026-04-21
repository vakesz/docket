"""End-to-end modal flow test.

Drives the TUI through: agent proposes mutation → DiffModal appears → user
approves (`y`) or rejects (`n`). Verifies that only `y` routes the proposal
through `mutation_service.confirm` and reaches the provider, while the agent
tool itself never mutates state.
"""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.cli.tui import ItvApp, TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider


def _mk_item(id_: str = "S-1") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title="Add login",
        description_md="Original.",
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


async def _select_story(app: ItvApp, pilot) -> None:
    tree = app.query_one(ItemTree)
    node = _find_node(tree.root, "S-1")
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


async def _drive_agent_turn(app: ItvApp, pilot, text: str) -> None:
    prompt = app.query_one(ChatPane).query_one("#prompt")
    prompt.value = text
    await prompt.action_submit()
    await app.workers.wait_for_complete()
    await pilot.pause()


@pytest.fixture
def modal_env(tmp_path: Path):
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
    yield ctx, client, provider, item
    conn.close()


async def test_confirm_routes_through_provider(modal_env) -> None:
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "start work on this")

        # Modal should now be on screen.
        assert isinstance(app.screen, DiffModal)
        await pilot.press("y")
        await pilot.pause()

        # Provider was mutated; cache reflects new state.
        assert provider.items[0].state == ItemState.ACTIVE
        cached = item_repo.get_item(ctx.conn, "S-1")
        assert cached is not None
        assert cached.state == ItemState.ACTIVE
        # Store drained.
        assert len(app._proposals) == 0


async def test_reject_leaves_provider_untouched(modal_env) -> None:
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "start work on this")

        assert isinstance(app.screen, DiffModal)
        await pilot.press("n")
        await pilot.pause()

        # Provider untouched; cache untouched.
        assert provider.items[0].state == ItemState.NEW
        cached = item_repo.get_item(ctx.conn, "S-1")
        assert cached is not None and cached.state == ItemState.NEW
        assert len(app._proposals) == 0


async def test_description_patch_confirm_applies_via_provider(modal_env) -> None:
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn(
            "tc-1",
            "propose_description_patch",
            '{"id":"S-1","new_description_md":"Rewritten body."}',
        ),
        text_turn("Staged."),
    ]
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "rewrite the description")

        assert isinstance(app.screen, DiffModal)
        await pilot.press("y")
        await pilot.pause()

        assert provider.items[0].description_md == "Rewritten body."
        cached = item_repo.get_item(ctx.conn, "S-1")
        assert cached is not None
        assert cached.description_md == "Rewritten body."


async def test_agent_tool_call_alone_does_not_mutate(modal_env) -> None:
    """Before any user decision, the agent tool must have left the provider untouched."""
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = ItvApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "start work")

        # Modal is open but no decision yet — provider still NEW.
        assert isinstance(app.screen, DiffModal)
        assert provider.items[0].state == ItemState.NEW
        assert len(app._proposals) == 1
