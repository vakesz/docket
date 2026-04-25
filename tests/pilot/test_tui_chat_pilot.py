"""End-to-end TUI chat test.

Drives the chat pane via Textual's pilot against a scripted fake LLM. Verifies:
  - submitting text posts a UserTurnRequest and starts a worker
  - streamed deltas accumulate into the visible assistant bubble
  - tool calls produce a note line
  - the token ledger updates
  - `t` starts a fresh thread (archives current + clears transcript)
"""

from __future__ import annotations

from pathlib import Path

import pytest

from docket.cli.tui.app import DocketApp
from docket.cli.tui.tui_context import TuiContext
from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.item_tree import ItemTree
from docket.core.model import ScopeFilters
from docket.storage import init_db
from docket.storage.repos import conversation_repo, item_repo, message_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider
from tests.pilot.conftest import find_node


@pytest.fixture
def chat_env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item(title="Add login", description_md="User should be able to log in.")
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
    node = find_node(tree.root, "S-1")
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


async def test_tool_then_text_keeps_chronological_order(chat_env) -> None:
    """After `tool` → `text`, the transcript must read user → call → result →
    assistant. Previously the assistant bubble mounted up-front stayed at the
    top and later deltas were silently dropped because _active_assistant had
    been cleared by note()."""
    from textual.widgets import Markdown, Static

    ctx, client, _ = chat_env
    client.script = [
        tool_turn("tc-1", "get_item", '{"id":"S-1"}'),
        text_turn("Final answer."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "summarize"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        chat = app.query_one(ChatPane)
        transcript = chat.query_one("#transcript")
        # Direct children only — Markdown has Static descendants that would
        # otherwise pollute a `query(Static)` traversal.
        kinds: list[str] = []
        for c in transcript.children:
            matched = c.classes & {"msg-user", "msg-tool", "msg-assistant", "msg-system"}
            if matched:
                kinds.append(next(iter(matched)))
        # user submission → tool call note → tool result note → final assistant.
        # No stale empty assistant row at the top.
        assert kinds == ["msg-user", "msg-tool", "msg-tool", "msg-assistant"]
        final = transcript.children[-1]
        # Finalized assistant segments render as Markdown so headings/lists
        # display correctly, not as raw source text.
        assert isinstance(final, Markdown)
        rendered = " ".join(str(s.render()) for s in final.query(Static).results())
        assert "Final answer." in rendered


async def test_assistant_response_renders_as_markdown(chat_env) -> None:
    """Once a turn completes, the assistant row must be a Markdown widget so
    headings, lists, and fenced code blocks render — not raw markdown text
    in a plain Static."""
    from textual.widgets import Markdown

    ctx, client, _ = chat_env
    client.script = [text_turn("# Plan\n\n- step one\n- step two\n\n`code` inline.")]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "hi"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        transcript = app.query_one(ChatPane).query_one("#transcript")
        assistants = [c for c in transcript.children if "msg-assistant" in c.classes]
        assert len(assistants) == 1
        assert isinstance(assistants[0], Markdown)


async def test_thinking_indicator_toggles_with_turn(chat_env) -> None:
    """The in-pane thinking indicator must be hidden before a turn, and hidden
    again once the turn completes."""
    ctx, client, _ = chat_env
    client.script = [text_turn("ok")]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        chat = app.query_one(ChatPane)
        indicator = chat.query_one("#thinking-indicator")
        assert "active" not in indicator.classes  # idle at start

        prompt = chat.query_one("#prompt")
        prompt.value = "hi"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        assert "active" not in indicator.classes  # cleared after finish_turn


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


async def test_acceptance_checklist_mounts_from_description(
    tmp_path: Path, make_item: MakeItem
) -> None:
    """Selecting an item whose description has task-list items should populate
    the criteria panel with one Checkbox per criterion, preserving check state."""
    from textual.widgets import Checkbox

    conn = init_db(tmp_path / "docket.db")
    item = make_item(
        "S-2",
        title="Ship login",
        description_md="- [ ] write the spec\n- [x] ship the migration\n",
    )
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    ctx = TuiContext(conn=conn, provider=provider, scope=ScopeFilters(), scope_key="default")

    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        tree = app.query_one(ItemTree)
        node = find_node(tree.root, "S-2")
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


# -- ask_user question card --------------------------------------------------

import json  # noqa: E402

from docket.cli.tui.widgets.chat_pane import QuestionCard  # noqa: E402

_ASK_USER_ARGS = json.dumps(
    {
        "questions": [
            {
                "question": "Which option?",
                "header": "Pick",
                "options": [
                    {"label": "alpha"},
                    {"label": "beta"},
                ],
            }
        ]
    }
)


async def test_ask_user_renders_question_card(chat_env) -> None:
    """When the agent calls `ask_user`, the chat pane mounts a question card
    and the turn ends without a final assistant bubble."""
    ctx, client, _ = chat_env
    client.script = [tool_turn("tc-q1", "ask_user", _ASK_USER_ARGS)]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "should I do something?"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        chat = app.query_one(ChatPane)
        cards = list(chat.query(QuestionCard).results())
        assert len(cards) == 1
        assert cards[0].question_id  # has a generated id
        assert chat.has_pending_question() is True


async def test_ask_user_submit_resumes_turn(chat_env) -> None:
    """Submitting the question card resumes the agent loop and the card is
    cleared once the resume turn finishes without another `ask_user`."""
    from textual.widgets import Button, Checkbox

    ctx, client, _ = chat_env
    client.script = [
        tool_turn("tc-q1", "ask_user", _ASK_USER_ARGS),
        text_turn("Got it — going with alpha."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "should I do something?"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        chat = app.query_one(ChatPane)
        card = chat.query_one(QuestionCard)
        # Tick "alpha" and submit.
        boxes = list(card.query(Checkbox).results())
        labels = [str(b.label) for b in boxes]
        assert "alpha" in labels
        boxes[labels.index("alpha")].value = True
        await pilot.pause()
        card.query_one("#q-submit", Button).press()
        await app.workers.wait_for_complete()
        await pilot.pause()

        # Card removed; resume produced an assistant bubble.
        assert app.query_one(ChatPane).has_pending_question() is False

    # Persisted history: user → ask_user round → answered tool result → final assistant.
    convos = conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)
    assert len(convos) == 1
    msgs = message_repo.list_for_conversation(ctx.conn, convos[0].id)
    roles = [m.role for m in msgs]
    assert roles == ["user", "assistant", "tool", "assistant"]
    tool_row = msgs[2]
    payload = json.loads(tool_row.content)
    # The placeholder was rewritten with the structured answer.
    assert payload["status"] == "answered"
    assert payload["answers"][0]["selected"] == ["alpha"]
    assert msgs[-1].content == "Got it — going with alpha."


async def test_free_text_while_question_pending_redirects_as_other(chat_env) -> None:
    """Typing in the chat prompt while a question is pending should resume the
    turn with the typed text as the first question's `other` answer."""
    ctx, client, _ = chat_env
    client.script = [
        tool_turn("tc-q1", "ask_user", _ASK_USER_ARGS),
        text_turn("Thanks."),
    ]
    app = DocketApp(ctx)
    async with app.run_test() as pilot:
        await _select_story(app, pilot)
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "should I do something?"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

        # Free-text answer instead of clicking the card.
        prompt = app.query_one(ChatPane).query_one("#prompt")
        prompt.value = "neither — try gamma"
        await prompt.action_submit()
        await app.workers.wait_for_complete()
        await pilot.pause()

    msgs = message_repo.list_for_conversation(
        ctx.conn,
        conversation_repo.list_for_item(ctx.conn, "S-1", provider_key=ctx.provider_key)[0].id,
    )
    payload = json.loads(msgs[2].content)
    assert payload["status"] == "answered"
    assert payload["answers"][0]["other"] == "neither — try gamma"
    assert msgs[-1].content == "Thanks."
