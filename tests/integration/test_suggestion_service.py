from __future__ import annotations

from pathlib import Path

import pytest

from docket.core.model import TransitionIntent
from docket.core.mutation import DescriptionPatch, StateChange
from docket.core.services import suggestion_service
from docket.core.services.suggestion_service import SuggestionError
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient, text_turn


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item("S-42", description_md="(needs detail)")
    item_repo.upsert_item(conn, item)
    yield conn, item
    conn.close()


def test_parses_clean_json(env) -> None:
    conn, item = env
    payload = (
        '{"intent": "start_work", '
        '"description_patch_md": "clearer text", '
        '"open_questions": ["q1", "q2"]}'
    )
    llm = FakeLlmClient(script=[text_turn(payload)])

    result = suggestion_service.suggest_next_action(conn, llm, item)

    assert result.intent == TransitionIntent.START_WORK
    assert result.description_patch_md == "clearer text"
    assert result.open_questions == ["q1", "q2"]
    assert result.item_id == item.id


def test_tolerates_prose_fenced_json(env) -> None:
    conn, item = env
    payload = (
        "Here's my recommendation:\n"
        '{"intent": "needs_info", '
        '"description_patch_md": "", '
        '"open_questions": ["which db?"]}'
        "\nLet me know if you want more."
    )
    llm = FakeLlmClient(script=[text_turn(payload)])

    result = suggestion_service.suggest_next_action(conn, llm, item)
    assert result.intent == TransitionIntent.NEEDS_INFO
    assert result.description_patch_md == ""
    assert result.open_questions == ["which db?"]


def test_rejects_unknown_intent(env) -> None:
    conn, item = env
    payload = '{"intent": "party_mode", "description_patch_md": "", "open_questions": []}'
    llm = FakeLlmClient(script=[text_turn(payload)])

    with pytest.raises(SuggestionError):
        suggestion_service.suggest_next_action(conn, llm, item)


def test_rejects_non_json(env) -> None:
    conn, item = env
    llm = FakeLlmClient(script=[text_turn("I dunno, maybe start work.")])

    with pytest.raises(SuggestionError):
        suggestion_service.suggest_next_action(conn, llm, item)


def test_rejects_bad_shapes(env) -> None:
    conn, item = env
    payload = '{"intent": "start_work", "description_patch_md": 42, "open_questions": []}'
    llm = FakeLlmClient(script=[text_turn(payload)])
    with pytest.raises(SuggestionError):
        suggestion_service.suggest_next_action(conn, llm, item)


def test_stage_returns_state_change_only_when_patch_empty(env) -> None:
    conn, item = env
    suggestion = suggestion_service.Suggestion(
        item_id=item.id,
        intent=TransitionIntent.CLOSE_DONE,
        description_patch_md="",
        open_questions=[],
    )
    staged = suggestion_service.stage_suggestion(conn, suggestion)
    assert isinstance(staged.state_change, StateChange)
    assert staged.state_change.intent == TransitionIntent.CLOSE_DONE
    assert staged.description_patch is None


def test_stage_includes_patch_when_non_empty(env) -> None:
    conn, item = env
    suggestion = suggestion_service.Suggestion(
        item_id=item.id,
        intent=TransitionIntent.START_WORK,
        description_patch_md="detailed acceptance criteria",
        open_questions=[],
    )
    staged = suggestion_service.stage_suggestion(conn, suggestion)
    assert isinstance(staged.state_change, StateChange)
    assert isinstance(staged.description_patch, DescriptionPatch)
    assert staged.description_patch.new_md == "detailed acceptance criteria"


def test_stage_requires_cached_item(env) -> None:
    conn, _ = env
    suggestion = suggestion_service.Suggestion(
        item_id="UNKNOWN",
        intent=TransitionIntent.START_WORK,
        description_patch_md="",
        open_questions=[],
    )
    with pytest.raises(KeyError):
        suggestion_service.stage_suggestion(conn, suggestion)


def test_open_questions_trimmed_and_filtered(env) -> None:
    conn, item = env
    payload = (
        '{"intent": "start_work", '
        '"description_patch_md": "", '
        '"open_questions": ["  real question  ", "", "   "]}'
    )
    llm = FakeLlmClient(script=[text_turn(payload)])
    result = suggestion_service.suggest_next_action(conn, llm, item)
    assert result.open_questions == ["real question"]
