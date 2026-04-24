"""End-to-end: user presses `s` → suggestion modal → accept stages proposals."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.cli.tui.app import DocketApp
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient, text_turn
from tests.fakes.provider import FakeProvider


def _mk_item() -> Item:
    return Item(
        id="S-1",
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


async def _select_story(app: DocketApp, pilot) -> None:
    tree = app.query_one(ItemTree)
    node = _find_node(tree.root, "S-1")
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


@pytest.fixture
def pilot_env(tmp_path: Path):
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
        external_watch_interval_seconds=0.0,  # keep the pilot deterministic
    )
    yield ctx, client, provider, item
    conn.close()


async def test_suggest_accept_stages_state_and_patch(pilot_env) -> None:
    ctx, client, provider, _ = pilot_env
    client.script = [
        text_turn(
            '{"intent": "start_work", '
            '"description_patch_md": "Clearer acceptance criteria.", '
            '"open_questions": []}'
        )
    ]

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await app.workers.wait_for_complete()
        await pilot.pause()
        await app.run_action("suggest_next")
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.pause()

        assert isinstance(app.screen, SuggestionModal)

        await pilot.press("y")
        await pilot.pause()

        # Two proposals staged → batch review modal, not a y/n chain.
        assert isinstance(app.screen, BatchDiffModal)
        assert len(app._proposals) == 2  # state_change + description_patch

        # Provider untouched until the user confirms the actual diff.
        assert provider.items[0].state == ItemState.NEW
        assert provider.items[0].description_md == "Original."


async def test_suggest_reject_leaves_store_empty(pilot_env) -> None:
    ctx, client, _, _ = pilot_env
    client.script = [
        text_turn(
            '{"intent": "needs_info", "description_patch_md": "", "open_questions": ["which env?"]}'
        )
    ]

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await app.workers.wait_for_complete()
        await pilot.pause()
        await app.run_action("suggest_next")
        await app.workers.wait_for_complete()
        await pilot.pause()
        await pilot.pause()

        assert isinstance(app.screen, SuggestionModal)
        await pilot.press("n")
        await pilot.pause()

        assert len(app._proposals) == 0


async def test_suggest_without_selection_notifies(pilot_env) -> None:
    ctx, client, _, _ = pilot_env
    client.script = []  # model should not be called
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("suggest_next")
        await pilot.pause()
        # No modal opened.
        assert not isinstance(app.screen, SuggestionModal)
        assert client.calls == []
