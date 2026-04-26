"""End-to-end: user presses `s` → suggestion modal → accept stages proposals."""

from __future__ import annotations

from pathlib import Path

import pytest
from textual.widgets import Input

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.core.model import ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn
from tests.fakes.provider import FakeProvider
from tests.pilot.conftest import find_node


async def _select_story(app: DocketApp, pilot) -> None:
    tree = app.query_one(ItemTree)
    node = find_node(tree.root, "S-1")
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


@pytest.fixture
def pilot_env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item(title="Add login", description_md="Original.")
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    client = FakeLlmClient()
    ctx = TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
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
        assert app.pending_proposal_count() == 2  # state_change + description_patch

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

        assert app.pending_proposal_count() == 0


async def test_suggest_refine_seeds_chat_input(pilot_env) -> None:
    ctx, client, provider, _ = pilot_env
    client.script = [
        text_turn(
            '{"intent": "needs_info", '
            '"description_patch_md": "Need repro steps.", '
            '"open_questions": ["which browser?"]}'
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
        await pilot.press("r")
        await pilot.pause()

        # Modal closed and nothing was staged — refining is a handoff,
        # not a stage.
        assert not isinstance(app.screen, SuggestionModal)
        assert app.pending_proposal_count() == 0
        assert provider.items[0].state == ItemState.NEW

        # Chat pane prompt is pre-filled with the suggestion as a draft.
        prompt = app.query_one(ChatPane).query_one("#prompt", Input)
        assert "needs_info" in prompt.value
        assert "Need repro steps." in prompt.value
        assert "which browser?" in prompt.value


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
