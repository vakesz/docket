"""`ask_user` tool — validation, staging, and awaiting-payload return."""

from __future__ import annotations

import json
from typing import Any

from docket.agent.question_tool import ASK_USER_TOOL_NAME, register_ask_user_tool
from docket.agent.tools import ToolRegistry
from docket.core.question import is_awaiting
from docket.core.services.question_store import QuestionStore


def _build_registry(
    *,
    convo_id: str = "c-1",
    tool_call_id: str = "tc-1",
    provider_key: str = "main",
    project_id: str = "p-1",
) -> tuple[ToolRegistry, QuestionStore]:
    store = QuestionStore()
    registry = ToolRegistry()
    register_ask_user_tool(
        registry,
        store=store,
        conversation_id=lambda: convo_id,
        current_tool_call_id=lambda: tool_call_id,
        provider_key=provider_key,
        project_id=project_id,
    )
    return registry, store


def _valid_args() -> dict[str, Any]:
    return {
        "questions": [
            {
                "question": "Pick a color",
                "header": "Color",
                "options": [
                    {"label": "red"},
                    {"label": "blue"},
                ],
            }
        ]
    }


def test_valid_call_stages_question_and_returns_awaiting_sentinel() -> None:
    registry, store = _build_registry()
    result = registry.dispatch(ASK_USER_TOOL_NAME, _valid_args())
    assert is_awaiting(result)
    payload = json.loads(result)
    assert payload["status"] == "awaiting_answer"
    qid = payload["question_id"]
    pending = store.peek(("main", "p-1", "c-1"))
    assert pending is not None
    assert pending.id == qid
    assert pending.tool_call_id == "tc-1"
    assert pending.questions[0].question == "Pick a color"
    # Allow_other is added implicitly — agents must not provide it.
    assert pending.questions[0].allow_other is True


def test_too_many_questions_returns_arg_error() -> None:
    registry, store = _build_registry()
    args = {
        "questions": [
            {
                "question": f"Q{i}",
                "header": f"H{i}",
                "options": [{"label": "a"}, {"label": "b"}],
            }
            for i in range(5)
        ]
    }
    result = registry.dispatch(ASK_USER_TOOL_NAME, args)
    payload = json.loads(result)
    assert "error" in payload
    assert len(store) == 0


def test_options_below_minimum_returns_arg_error() -> None:
    registry, store = _build_registry()
    args = {
        "questions": [
            {
                "question": "Q",
                "header": "H",
                "options": [{"label": "only"}],
            }
        ]
    }
    result = registry.dispatch(ASK_USER_TOOL_NAME, args)
    assert json.loads(result).get("error")
    assert len(store) == 0


def test_options_above_maximum_returns_arg_error() -> None:
    registry, store = _build_registry()
    args = {
        "questions": [
            {
                "question": "Q",
                "header": "H",
                "options": [{"label": chr(ord("a") + i)} for i in range(5)],
            }
        ]
    }
    assert json.loads(registry.dispatch(ASK_USER_TOOL_NAME, args)).get("error")
    assert len(store) == 0


def test_long_header_returns_arg_error() -> None:
    registry, store = _build_registry()
    args = _valid_args()
    args["questions"][0]["header"] = "X" * 13
    assert json.loads(registry.dispatch(ASK_USER_TOOL_NAME, args)).get("error")
    assert len(store) == 0


def test_duplicate_option_labels_return_arg_error() -> None:
    registry, store = _build_registry()
    args = {
        "questions": [
            {
                "question": "Q",
                "header": "H",
                "options": [{"label": "x"}, {"label": "x"}],
            }
        ]
    }
    assert json.loads(registry.dispatch(ASK_USER_TOOL_NAME, args)).get("error")
    assert len(store) == 0


def test_missing_conversation_id_returns_arg_error() -> None:
    """No active conversation context (caller forgot to plumb the loop) — the
    tool must refuse rather than stage an unbound question."""
    store = QuestionStore()
    registry = ToolRegistry()
    register_ask_user_tool(
        registry,
        store=store,
        conversation_id=lambda: "",
        current_tool_call_id=lambda: "tc-1",
    )
    assert json.loads(registry.dispatch(ASK_USER_TOOL_NAME, _valid_args())).get("error")
    assert len(store) == 0


def test_multi_select_flag_round_trips() -> None:
    registry, store = _build_registry()
    args = _valid_args()
    args["questions"][0]["multi_select"] = True
    registry.dispatch(ASK_USER_TOOL_NAME, args)
    pending = store.peek(("main", "p-1", "c-1"))
    assert pending is not None
    assert pending.questions[0].multi_select is True
