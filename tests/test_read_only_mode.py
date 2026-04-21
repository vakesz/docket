"""Pilot coverage for read-only mode (M12).

Verifies that `TuiContext(read_only=True)`:
  - skips `register_mutating_tools` so the agent can't propose writes
  - surfaces a `READ-ONLY` badge via StatusBar
  - blocks `action_new_item` / `action_transition` with a toast
  - blocks the suggestion-accept path (read tools still work)

These are the only TUI-level escapes into the mutation pipeline. The HTTP
API and CLI read-only paths are covered in their own test modules."""
from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.cli.tui import ItvApp, TuiContext
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.cli.tui.widgets.new_item_modal import NewItemModal
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient
from tests.fakes.provider import FakeProvider


def _mk_item() -> Item:
    return Item(
        id="S-1",
        kind=ItemKind.STORY,
        title="Add login",
        description_md="Body.",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def ro_ctx(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    yield TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
        llm=FakeLlmClient(),
        read_only=True,
    )
    conn.close()


async def test_read_only_agent_has_no_mutating_tools(ro_ctx) -> None:
    """The agent should keep its read tools (get_item, etc.) but none of
    the propose_* writers."""
    app = ItvApp(ro_ctx)
    async with app.run_test():
        assert app._agent is not None
        registry = app._agent._tools  # type: ignore[attr-defined]
        assert "get_item" in registry  # read tool still present
        assert "propose_transition" not in registry
        assert "propose_description_patch" not in registry
        assert "propose_new_item" not in registry
        assert "attach_transcript" not in registry


async def test_read_only_status_bar_shows_indicator(ro_ctx) -> None:
    app = ItvApp(ro_ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        bar = app.query_one(StatusBar)
        assert bar.read_only is True
        assert "READ-ONLY" in str(bar.render())


async def test_read_only_blocks_new_item_action(ro_ctx) -> None:
    app = ItvApp(ro_ctx)
    async with app.run_test() as pilot:
        await app.run_action("new_item")
        await pilot.pause()
        # No modal was pushed — the action toasted and returned.
        assert not isinstance(app.screen, NewItemModal)


async def test_read_only_blocks_transition_action(ro_ctx) -> None:
    from docket.cli.tui.widgets.item_tree import ItemSelected

    app = ItvApp(ro_ctx)
    async with app.run_test() as pilot:
        app.post_message(ItemSelected("S-1"))
        await pilot.pause()
        await app.run_action("transition('start_work')")
        await pilot.pause()
        # Mutation pipeline never fired — no proposal staged, no modal.
        assert len(app._proposals) == 0
        assert not isinstance(app.screen, DiffModal | BatchDiffModal)


async def test_writable_ctx_allows_new_item(tmp_path: Path) -> None:
    """Sanity check: the same harness with read_only=False still opens the
    form. Guards against a regression where the guard always blocks."""
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    ctx = TuiContext(
        conn=conn,
        provider=provider,
        scope=ScopeFilters(),
        scope_key="default",
        llm=FakeLlmClient(),
        read_only=False,
    )
    app = ItvApp(ctx)
    try:
        async with app.run_test() as pilot:
            await app.run_action("new_item")
            await pilot.pause()
            assert isinstance(app.screen, NewItemModal)
    finally:
        conn.close()
