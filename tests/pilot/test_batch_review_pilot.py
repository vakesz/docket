"""End-to-end batch-review flow test.

When two or more proposals are queued, the TUI opens a `BatchDiffModal`
instead of chaining y/n modals. Covers:

- queue length >= 2 → BatchDiffModal opens (not DiffModal)
- queue length == 1 → existing DiffModal still opens (no regression)
- apply-all confirms each proposal through `mutation_service.confirm`
- reject-all drains the queue without touching the provider
- apply-selected confirms only checked rows, drops unchecked
- esc/cancel leaves the queue untouched for a later review pass
- end-to-end: agent stages 3 proposals in one turn → a single review pass
"""

from __future__ import annotations

from pathlib import Path

import pytest
from textual.widgets import Checkbox

from docket.cli.tui.app import DocketApp, TuiContext
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.core.model import ItemState, ScopeFilters, TransitionIntent
from docket.core.mutation import StateChange
from docket.core.services import mutation_service
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider
from tests.pilot.conftest import find_node


async def _select(app: DocketApp, pilot, id_: str) -> None:
    tree = app.query_one(ItemTree)
    node = find_node(tree.root, id_)
    assert node is not None
    tree.select_node(node)
    await pilot.pause()


@pytest.fixture
def batch_env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    items = [
        make_item(id_, title=f"Item {id_}", description_md="Original body.")
        for id_ in ("S-1", "S-2", "S-3")
    ]
    for it in items:
        item_repo.upsert_item(conn, it)
    provider = FakeProvider(items=list(items))
    client = FakeLlmClient()
    ctx = TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        llm=client,
    )
    yield ctx, client, provider
    conn.close()


def _stage_two_transitions(app: DocketApp, conn) -> tuple[str, str]:
    """Hand-stage two transition proposals bypassing the agent, so the
    batch-UX tests don't depend on agent-loop scripting."""
    p1 = StateChange(
        item=mutation_service.require_cached_item(conn, "S-1"),
        intent=TransitionIntent.START_WORK,
    )
    p2 = StateChange(
        item=mutation_service.require_cached_item(conn, "S-2"),
        intent=TransitionIntent.START_WORK,
    )
    app.stage_proposal(p1, source="agent")
    app.stage_proposal(p2, source="agent")
    return p1.id, p2.id


async def test_batch_modal_opens_when_two_or_more_queued(batch_env) -> None:
    ctx, _, _ = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        _stage_two_transitions(app, ctx.conn)
        await app.run_action("review_pending")
        await pilot.pause()
        assert isinstance(app.screen, BatchDiffModal)
        # One Checkbox per queued proposal.
        boxes = list(app.screen.query(Checkbox).results())
        assert len(boxes) == 2
        # All pre-checked: the default "apply all" case.
        assert all(b.value for b in boxes)


async def test_single_proposal_still_uses_diff_modal(batch_env) -> None:
    ctx, _, _ = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        p = StateChange(
            item=mutation_service.require_cached_item(ctx.conn, "S-1"),
            intent=TransitionIntent.START_WORK,
        )
        app.stage_proposal(p, source="agent")
        await app.run_action("review_pending")
        await pilot.pause()
        assert isinstance(app.screen, DiffModal)
        assert not isinstance(app.screen, BatchDiffModal)


async def test_apply_all_confirms_each_through_provider(batch_env) -> None:
    ctx, _, provider = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        _stage_two_transitions(app, ctx.conn)
        await app.run_action("review_pending")
        await pilot.pause()
        assert isinstance(app.screen, BatchDiffModal)

        await pilot.press("a")
        await pilot.pause()

        # Both items transitioned at the provider.
        by_id = {it.id: it for it in provider.items}
        assert by_id["S-1"].state == ItemState.ACTIVE
        assert by_id["S-2"].state == ItemState.ACTIVE
        # Queue fully drained.
        assert app.pending_proposal_count() == 0


async def test_reject_all_drains_without_touching_provider(batch_env) -> None:
    ctx, _, provider = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        _stage_two_transitions(app, ctx.conn)
        await app.run_action("review_pending")
        await pilot.pause()

        await pilot.press("r")
        await pilot.pause()

        by_id = {it.id: it for it in provider.items}
        assert by_id["S-1"].state == ItemState.NEW
        assert by_id["S-2"].state == ItemState.NEW
        assert app.pending_proposal_count() == 0


async def test_apply_selected_drops_unchecked_rows(batch_env) -> None:
    """Unchecking a row and pressing `y` applies only the checked proposals
    and drops the unchecked one — the queue drains entirely in one pass."""
    ctx, _, provider = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        p1_id, _p2_id = _stage_two_transitions(app, ctx.conn)
        await app.run_action("review_pending")
        await pilot.pause()
        assert isinstance(app.screen, BatchDiffModal)

        # Uncheck the S-1 proposal — only S-2 should apply.
        cb = app.screen.query_one(f"#cb-{p1_id}", Checkbox)
        cb.value = False
        await pilot.pause()

        await pilot.press("y")
        await pilot.pause()

        by_id = {it.id: it for it in provider.items}
        assert by_id["S-1"].state == ItemState.NEW  # dropped, not applied
        assert by_id["S-2"].state == ItemState.ACTIVE  # applied
        assert app.pending_proposal_count() == 0


async def test_cancel_preserves_queue_for_later(batch_env) -> None:
    ctx, _, provider = batch_env
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        _stage_two_transitions(app, ctx.conn)
        await app.run_action("review_pending")
        await pilot.pause()

        await pilot.press("escape")
        await pilot.pause()

        # Queue untouched, provider untouched — user can come back.
        assert app.pending_proposal_count() == 2
        by_id = {it.id: it for it in provider.items}
        assert by_id["S-1"].state == ItemState.NEW
        assert by_id["S-2"].state == ItemState.NEW


async def test_agent_three_proposals_land_in_single_review_pass(batch_env) -> None:
    """Three agent tool calls in one turn should land in one batch modal, not
    a chain of three. The script drives three tool rounds feeding back through
    the agent loop; after the text turn closes the cycle there should be three
    pending proposals and one BatchDiffModal on screen."""
    ctx, client, provider = batch_env
    client.script = [
        tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
        tool_turn("tc-2", "propose_transition", '{"id":"S-2","intent":"start_work"}'),
        tool_turn("tc-3", "propose_transition", '{"id":"S-3","intent":"start_work"}'),
        text_turn("Staged three."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select(app, pilot, "S-1")
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "start work on all three"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert isinstance(app.screen, BatchDiffModal)
        boxes = list(app.screen.query(Checkbox).results())
        assert len(boxes) == 3

        await pilot.press("a")
        await pilot.pause()

        by_id = {it.id: it for it in provider.items}
        assert by_id["S-1"].state == ItemState.ACTIVE
        assert by_id["S-2"].state == ItemState.ACTIVE
        assert by_id["S-3"].state == ItemState.ACTIVE
        assert app.pending_proposal_count() == 0
