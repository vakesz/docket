"""Smoke tests for the three-pane TUI, using Textual's pilot driver.

These are intentionally narrow: we verify the app mounts, the item tree populates
from the local cache, selecting a node updates the detail/chat panes, and the
refresh action drives the sync service. Anything deeper (styling, terminal
rendering) is left to manual QA.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from textual.widgets import Input

from docket.cli.tui import DocketApp, TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_detail import ItemDetail
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.cli.tui.widgets.status_bar import StatusBar
from docket.config import Config, ProjectEntry, ProviderEntry
from docket.core.model import Comment, Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import comment_repo, item_repo
from tests.fakes.provider import FakeProvider


def _find_node(node, target_id: str):
    for child in node.children:
        if child.data == target_id:
            return child
        found = _find_node(child, target_id)
        if found is not None:
            return found
    return None


def _mk_item(
    id: str,
    *,
    kind: ItemKind = ItemKind.STORY,
    title: str = "A story",
    state: ItemState = ItemState.NEW,
    parent_id: str | None = None,
    description_md: str = "Hello",
) -> Item:
    return Item(
        id=id,
        kind=kind,
        title=title,
        description_md=description_md,
        state=state,
        assignee=None,
        parent_id=parent_id,
        tags=[],
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def tui_setup(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    epic = _mk_item("E-1", kind=ItemKind.EPIC, title="Platform")
    story = _mk_item("S-1", kind=ItemKind.STORY, title="Add login", parent_id="E-1")
    bug = _mk_item("B-1", kind=ItemKind.BUG, title="Login crash", state=ItemState.ACTIVE)
    for it in (epic, story, bug):
        item_repo.upsert_item(conn, it)
    comment_repo.replace_comments_for_item(
        conn,
        "S-1",
        [
            Comment(
                id="c-1",
                item_id="S-1",
                author="alice",
                body_md="Looks good.",
                created_at=datetime.now(UTC),
            )
        ],
    )
    provider = FakeProvider(items=[epic, story, bug])
    ctx = TuiContext(conn=conn, provider=provider, scope=ScopeFilters(), scope_key="default")
    yield ctx, provider
    conn.close()


async def test_tree_populates_on_mount(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        tree = app.query_one(ItemTree)
        # Five kind buckets (epic/feature/story/task/bug) under the hidden root.
        assert len(tree.root.children) == 5
        labels = [str(n.label) for n in tree.root.children]
        assert any("Epics" in label for label in labels)
        assert any("Bugs" in label for label in labels)
        await pilot.pause()


async def test_select_item_updates_detail_and_chat(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        tree = app.query_one(ItemTree)
        story_node = _find_node(tree.root, "S-1")
        assert story_node is not None
        tree.select_node(story_node)
        await pilot.pause()

        detail = app.query_one(ItemDetail)
        meta = detail.query_one("#meta")
        assert "Add login" in str(meta.render())

        chat = app.query_one(ChatPane)
        title = chat.query_one("#chat-title")
        assert "S-1" in str(title.render())


async def test_layout_has_status_bar_and_no_header(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        assert not list(app.query("Header"))
        bar = app.query_one(StatusBar)
        assert isinstance(bar, StatusBar)
        assert bar.size.height == 1
        assert "FakeProvider" in str(bar.render())


async def test_tree_rows_show_short_ids_and_status_bar_shows_project_name(tui_setup) -> None:
    ctx, _ = tui_setup
    pid = "FakeProvider"
    ctx.provider_key = pid
    short_id_item = _mk_item("Ericsson/CodeChecker#1", title="Upgrade Vue")
    short_id_item.provider_key = pid
    item_repo.upsert_item(ctx.conn, short_id_item)
    ctx.provider.items.append(short_id_item)
    ctx.config = Config(
        providers={},
        active_provider=pid,
        projects={pid: ProjectEntry(provider_key=pid, name="Ericsson/CodeChecker")},
    )
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = app.query_one(ItemTree)
        node = _find_node(tree.root, "Ericsson/CodeChecker#1")
        assert node is not None
        label = str(node.label)
        assert "#1" in label
        assert "Ericsson/CodeChecker#1" not in label

        bar = app.query_one(StatusBar)
        assert bar.project_name == "Ericsson/CodeChecker"
        assert "Ericsson/CodeChecker" in str(bar.render())


def _tree_bucket_labels(tree: ItemTree) -> list[str]:
    """Top-level bucket labels under the hidden root, with pinned stripped.

    The Pinned section only appears when items are pinned, so tests that only
    care about the kind/state-bucket row can ignore it via the "📌" prefix."""
    return [str(n.label) for n in tree.root.children if not str(n.label).startswith("📌")]


async def test_github_provider_uses_state_bucket_grouping(tui_setup) -> None:
    """GitHub's ProviderSpec.grouping="by_state_bucket" must reach the tree:
    "Open" and "Done" buckets instead of the ADO kind hierarchy."""
    ctx, _ = tui_setup
    pid = "gh-main"
    ctx.provider_key = pid
    # Swap the cached items so they're owned by the GitHub-typed provider key.
    for item in list(ctx.provider.items):
        item.provider_key = pid
        item_repo.upsert_item(ctx.conn, item)
    ctx.config = Config(
        providers={
            pid: ProviderEntry(type="github_stub", display_name="GH", config={}),
        },
        active_provider=pid,
    )
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        labels = _tree_bucket_labels(app.query_one(ItemTree))
        assert any(label.startswith("Open ") for label in labels)
        assert any(label.startswith("Done ") for label in labels)
        assert not any("Epics" in label for label in labels)


async def test_azure_provider_keeps_kind_grouping(tui_setup) -> None:
    """Azure DevOps is the default, and its hierarchy is what the existing
    kind buckets encode. Re-check so the test doubles as a regression guard
    when new providers are added to the registry."""
    ctx, _ = tui_setup
    pid = "ado-main"
    ctx.provider_key = pid
    for item in list(ctx.provider.items):
        item.provider_key = pid
        item_repo.upsert_item(ctx.conn, item)
    ctx.config = Config(
        providers={
            pid: ProviderEntry(type="azure_devops", display_name="ADO", config={}),
        },
        active_provider=pid,
    )
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        labels = _tree_bucket_labels(app.query_one(ItemTree))
        assert any("Epics" in label for label in labels)
        assert any("Bugs" in label for label in labels)
        assert not any(label.startswith("Open ") for label in labels)


async def test_closed_items_hidden_by_default_and_toggle_reveals_them(tui_setup) -> None:
    """`hide_done` defaults to True so the backlog matches the frontend's
    "open" bucket; `c` flips it and the tree repaints with the closed rows."""
    ctx, _ = tui_setup
    closed = _mk_item("C-1", kind=ItemKind.TASK, title="Old and done", state=ItemState.CLOSED)
    item_repo.upsert_item(ctx.conn, closed)
    ctx.provider.items.append(closed)
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = app.query_one(ItemTree)
        assert _find_node(tree.root, "C-1") is None

        await app.run_action("toggle_done_visibility")
        await pilot.pause()
        tree = app.query_one(ItemTree)
        assert _find_node(tree.root, "C-1") is not None


async def test_refresh_action_invokes_sync(tui_setup) -> None:
    ctx, provider = tui_setup
    # Add a fresh item on the provider only; refresh should pull it into the cache.
    provider.items.append(_mk_item("T-1", kind=ItemKind.TASK, title="New task from provider"))
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("refresh")
        await pilot.pause()

    cached = item_repo.get_item(ctx.conn, "T-1")
    assert cached is not None
    assert cached.title == "New task from provider"


async def test_filter_input_narrows_tree(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        # Focus the filter and type a query that only matches the bug.
        await pilot.press("slash")
        await pilot.pause()
        from textual.widgets import Input

        filter_input = app.query_one("#filter", Input)
        filter_input.value = "crash"
        await filter_input.action_submit()
        await pilot.pause()

        tree = app.query_one(ItemTree)
        # Flatten all item-bearing nodes; only the bug should remain.
        remaining_ids = [
            child.data
            for bucket in tree.root.children
            for child in bucket.children
            if isinstance(child.data, str)
        ]
        assert remaining_ids == ["B-1"]


async def test_selected_tree_row_has_continuous_background(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await pilot.pause()
        tree = app.query_one(ItemTree)
        tree.focus()
        node = _find_node(tree.root, "S-1")
        assert node is not None
        tree.select_node(node)
        await pilot.pause()

        strip = tree.render_line(node.line)
        backgrounds = {segment.style.bgcolor for segment in strip._segments if segment.text}
        assert backgrounds
        assert len(backgrounds) == 1
        assert None not in backgrounds


async def test_filter_down_moves_focus_into_tree(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("focus_filter")
        await pilot.pause()
        await pilot.press("down")
        await pilot.pause()

        tree = app.query_one(ItemTree)
        assert tree.has_focus
        assert tree.cursor_node is not None
        assert isinstance(tree.cursor_node.data, str)


async def test_tree_up_from_first_item_moves_focus_to_filter(tui_setup) -> None:
    ctx, _ = tui_setup
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("focus_filter")
        await pilot.pause()
        await pilot.press("down")
        await pilot.pause()
        await pilot.press("up")
        await pilot.pause()

        filter_input = app.query_one("#filter", Input)
        assert filter_input.has_focus


async def test_tree_clamps_virtual_width_to_viewport(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "docket.db")
    long_title = "This is a very long ticket title that should stay on one line and trim cleanly in the tree view"
    item = _mk_item("S-long", title=long_title)
    item_repo.upsert_item(conn, item)
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[item]),
        scope=ScopeFilters(),
        scope_key="default",
    )
    app = DocketApp(ctx)
    try:
        async with app.run_test() as pilot:
            await pilot.pause()
            tree = app.query_one(ItemTree)
            assert tree.virtual_size.width <= tree.size.width
    finally:
        conn.close()
