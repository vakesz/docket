"""End-to-end modal flow test.

Drives the TUI through: agent proposes mutation → DiffModal appears → user
approves (`y`) or rejects (`n`). Verifies that only `y` routes the proposal
through `mutation_service.confirm` and reaches the provider, while the agent
tool itself never mutates state.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.core.model import ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider
from tests.pilot.conftest import find_node


async def _select_story(app: DocketApp, pilot) -> None:
    tree = app.query_one(ItemTree)
    node = find_node(tree.root, "S-1")
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


async def _drive_agent_turn(app: DocketApp, pilot, text: str) -> None:
    prompt = app.query_one(ChatPane).query_one("#prompt")
    prompt.value = text
    await prompt.action_submit()
    await app.workers.wait_for_complete()
    await pilot.pause()


@pytest.fixture
def modal_env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item(title="Add login", description_md="Original.")
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
    app = DocketApp(ctx)
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
        assert app.pending_proposal_count() == 0


async def test_reject_leaves_provider_untouched(modal_env) -> None:
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = DocketApp(ctx)
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
        assert app.pending_proposal_count() == 0


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
    app = DocketApp(ctx)
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


async def test_edit_action_rewrites_description_before_confirm(modal_env) -> None:
    """Pressing `e` swaps the diff for a TextArea; Ctrl+S rebuilds the
    proposal with the edited text. Confirm then applies the edited version
    to the provider — not the original the agent proposed."""
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn(
            "tc-1",
            "propose_description_patch",
            '{"id":"S-1","new_description_md":"Agent draft."}',
        ),
        text_turn("Staged."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "rewrite the description")

        assert isinstance(app.screen, DiffModal)
        await pilot.press("e")
        await pilot.pause()

        from textual.widgets import TextArea

        editor = app.screen.query_one("#editor", TextArea)
        assert editor.text == "Agent draft."
        editor.text = "Human override."
        await pilot.press("ctrl+s")
        await pilot.pause()
        await pilot.press("y")
        await pilot.pause()

        assert provider.items[0].description_md == "Human override."


async def test_edit_unsupported_for_transition(modal_env) -> None:
    """`e` on a state-change proposal is a no-op warning — the modal stays
    open on the diff view so the user can still y/n the transition."""
    ctx, client, _provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "start work")

        assert isinstance(app.screen, DiffModal)
        await pilot.press("e")
        await pilot.pause()
        # Still on the modal; no editor mounted.
        assert isinstance(app.screen, DiffModal)
        assert app.screen._editor is None


async def test_agent_tool_call_alone_does_not_mutate(modal_env) -> None:
    """Before any user decision, the agent tool must have left the provider untouched."""
    ctx, client, provider, _ = modal_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        text_turn("Staged."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        await _drive_agent_turn(app, pilot, "start work")

        # Modal is open but no decision yet — provider still NEW.
        assert isinstance(app.screen, DiffModal)
        assert provider.items[0].state == ItemState.NEW
        assert app.pending_proposal_count() == 1
