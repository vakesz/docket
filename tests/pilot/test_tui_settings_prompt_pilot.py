from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from docket.cli.tui import DocketApp, TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.help_modal import HelpModal
from docket.cli.tui.widgets.prompt_library import PromptLibraryModal
from docket.cli.tui.widgets.settings_modal import SettingsModal
from docket.config import Config, ProviderEntry, ScopeFilter, load_config, resolve_paths
from docket.core.model import Item, ItemKind, ItemState, ScopeFilters
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.provider import FakeProvider


def _mk_item(id_: str = "S-1", *, title: str = "Add login") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title=title,
        description_md="- [ ] Ship login\n- [ ] Add tests",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


async def test_help_modal_opens_from_action(tmp_xdg: Path) -> None:
    conn = init_db(tmp_xdg / "state" / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    ctx = TuiContext(conn=conn, provider=FakeProvider(items=[item]), scope=ScopeFilters())
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("show_help")
        await pilot.pause()
        assert isinstance(app.screen, HelpModal)
    conn.close()


async def test_settings_modal_persists_and_updates_runtime(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    cfg = Config(
        providers={
            "azure_devops": ProviderEntry(
                type="azure_devops",
                display_name="Azure DevOps",
                config={"organization": "https://dev.azure.com/example", "project": "Demo"},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            ),
        },
        active_provider="azure_devops",
    )
    item = _mk_item()
    conn = init_db(paths.db_file)
    item_repo.upsert_item(conn, item)
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[item]),
        provider_key="azure_devops",
        scope=ScopeFilters(),
        scope_key="default",
        paths=paths,
        config=cfg,
    )

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("open_settings")
        await pilot.pause()
        assert isinstance(app.screen, SettingsModal)

        modal = app.screen
        modal.query_one("#scope-name").value = "focused"
        modal.query_one("#scope-default").value = True
        modal.query_one("#scope-team").value = "Platform"
        modal.query_one("#ui-show-criteria").value = False
        modal.query_one("#ui-default-kind").value = "bug"
        modal.query_one("#stale-threshold").value = "3"
        await pilot.press("ctrl+s")
        await pilot.pause()

        assert app.tui_ctx.default_new_item_kind == ItemKind.BUG
        assert app.query_one(ChatPane)._show_acceptance_criteria is False

    reloaded = load_config(paths)
    azure_devops_entry = reloaded.providers["azure_devops"]
    assert azure_devops_entry.active_scope == "focused"
    assert azure_devops_entry.scopes["focused"].team == "Platform"
    assert reloaded.ui.default_new_item_kind == "bug"
    assert reloaded.ui.show_acceptance_criteria is False
    assert reloaded.stale.threshold_days == 3
    conn.close()


async def test_prompt_library_modal_saves_prompt_from_the_app(tmp_xdg: Path) -> None:
    paths = resolve_paths()
    paths.ensure()
    item = _mk_item()
    conn = init_db(paths.db_file)
    item_repo.upsert_item(conn, item)
    ctx = TuiContext(
        conn=conn,
        provider=FakeProvider(items=[item]),
        scope=ScopeFilters(),
        paths=paths,
    )
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await app.run_action("edit_prompts")
        await pilot.pause()
        assert isinstance(app.screen, PromptLibraryModal)

        modal = app.screen
        modal.query_one("#prompt-key").value = "story"
        await pilot.pause()
        modal.query_one("#editor").text = "CUSTOM STORY"
        await pilot.press("ctrl+s")
        await pilot.pause()

    assert (paths.prompts_dir / "kind_story.md").read_text(encoding="utf-8") == "CUSTOM STORY"
    conn.close()
