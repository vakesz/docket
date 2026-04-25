"""Agent tool for asking the user a structured question.

Calling `ask_user` stages a `Question` in the `QuestionStore` and returns the
"awaiting_answer" sentinel. The agent loop sees the sentinel, persists the
tool-result as `pending=1`, and ends the turn. The UI renders the question
card; when the user answers, the placeholder tool-result is overwritten with
the structured answers and a fresh agent turn picks up from there.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from docket.agent._helpers import arg_error
from docket.agent.tools import ToolRegistry
from docket.core.question import (
    Question,
    QuestionItem,
    QuestionOption,
    awaiting_payload,
)
from docket.core.services.question_store import QuestionStore

ASK_USER_TOOL_NAME = "ask_user"

_DESCRIPTION = (
    "Ask the user a structured question with predefined choices. The user sees "
    "a card with selectable options; their answer is returned to you on the next "
    "turn. ALWAYS use this instead of putting questions in your prose. You may "
    "narrate brief context first, but the question itself goes through this tool. "
    "Calling this tool ends your turn — do not call other tools in the same response. "
    "Each question gets an automatic 'Other' free-text choice; you do not need to add it."
)

_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "questions": {
            "type": "array",
            "minItems": 1,
            "maxItems": 4,
            "description": "1-4 related questions to ask in one card.",
            "items": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The full question text shown to the user.",
                    },
                    "header": {
                        "type": "string",
                        "description": "Short label (<=12 chars) shown as a chip.",
                    },
                    "multi_select": {
                        "type": "boolean",
                        "description": "True when choices are not mutually exclusive.",
                        "default": False,
                    },
                    "options": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 4,
                        "description": "2-4 mutually exclusive (or multi-select) choices.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["label"],
                        },
                    },
                },
                "required": ["question", "header", "options"],
            },
        },
    },
    "required": ["questions"],
}

_HEADER_LIMIT = 12
_MAX_QUESTIONS = 4
_MIN_OPTIONS = 2
_MAX_OPTIONS = 4


def _parse_questions(raw: Any) -> tuple[QuestionItem, ...]:
    if not isinstance(raw, list) or not raw:
        raise ValueError("questions must be a non-empty array")
    if len(raw) > _MAX_QUESTIONS:
        raise ValueError(f"at most {_MAX_QUESTIONS} questions per call")
    parsed: list[QuestionItem] = []
    for idx, q in enumerate(raw):
        if not isinstance(q, dict):
            raise ValueError(f"questions[{idx}] must be an object")
        text = str(q.get("question", "")).strip()
        if not text:
            raise ValueError(f"questions[{idx}].question is required")
        header = str(q.get("header", "")).strip()
        if not header:
            raise ValueError(f"questions[{idx}].header is required")
        if len(header) > _HEADER_LIMIT:
            raise ValueError(
                f"questions[{idx}].header must be <= {_HEADER_LIMIT} chars"
            )
        multi_select = bool(q.get("multi_select", False))
        opts_raw = q.get("options")
        if not isinstance(opts_raw, list):
            raise ValueError(f"questions[{idx}].options must be an array")
        if not (_MIN_OPTIONS <= len(opts_raw) <= _MAX_OPTIONS):
            raise ValueError(
                f"questions[{idx}].options must have {_MIN_OPTIONS}-{_MAX_OPTIONS} entries"
            )
        opts: list[QuestionOption] = []
        for oidx, opt in enumerate(opts_raw):
            if not isinstance(opt, dict):
                raise ValueError(f"questions[{idx}].options[{oidx}] must be an object")
            label = str(opt.get("label", "")).strip()
            if not label:
                raise ValueError(
                    f"questions[{idx}].options[{oidx}].label is required"
                )
            description = str(opt.get("description", "") or "")
            opts.append(QuestionOption(label=label, description=description))
        labels = [o.label for o in opts]
        if len(set(labels)) != len(labels):
            raise ValueError(f"questions[{idx}].options labels must be unique")
        parsed.append(
            QuestionItem(
                question=text,
                header=header,
                multi_select=multi_select,
                options=tuple(opts),
                allow_other=True,
            )
        )
    return tuple(parsed)


def register_ask_user_tool(
    registry: ToolRegistry,
    *,
    store: QuestionStore,
    conversation_id: Callable[[], str],
    current_tool_call_id: Callable[[], str],
    provider_key: str = "",
    project_id: str = "",
) -> None:
    """Register the `ask_user` tool.

    `conversation_id` and `current_tool_call_id` are callables resolved at
    invocation time — the loop sets the current tool-call id before dispatch
    so the staged question can carry it through to the placeholder tool
    result.
    """

    def ask_user(args: dict[str, Any]) -> str:
        try:
            questions = _parse_questions(args.get("questions"))
        except ValueError as e:
            return arg_error(str(e))
        convo_id = conversation_id() or ""
        tool_call_id = current_tool_call_id() or ""
        if not convo_id or not tool_call_id:
            return arg_error("ask_user is not available in this context")
        question = Question(
            tool_call_id=tool_call_id,
            conversation_id=convo_id,
            provider_key=provider_key,
            project_id=project_id,
            questions=questions,
        )
        store.stage(question)
        return awaiting_payload(question.id)

    registry.register(
        name=ASK_USER_TOOL_NAME,
        description=_DESCRIPTION,
        parameters=_PARAMETERS,
        handler=ask_user,
    )


__all__ = ["ASK_USER_TOOL_NAME", "register_ask_user_tool"]
