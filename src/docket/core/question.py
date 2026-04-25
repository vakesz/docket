"""Structured user questions staged by the `ask_user` agent tool.

The agent stages a `Question` (1-4 question items, each with options) into the
`QuestionStore`. The UI renders the question card inline in the assistant's
bubble; the user's selections come back through a dedicated answer endpoint
that fills in the placeholder tool-result and resumes the conversation.

Mirrors the proposal pattern but is non-mutating: questions don't touch the
provider, just gate the next agent turn on a structured user response.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field


def _new_id() -> str:
    return str(uuid.uuid4())


@dataclass(frozen=True)
class QuestionOption:
    label: str
    description: str = ""


@dataclass(frozen=True)
class QuestionItem:
    question: str
    header: str
    multi_select: bool
    options: tuple[QuestionOption, ...]
    allow_other: bool = True


@dataclass(frozen=True)
class Question:
    tool_call_id: str
    conversation_id: str
    provider_key: str
    project_id: str
    questions: tuple[QuestionItem, ...]
    id: str = field(default_factory=_new_id)


@dataclass(frozen=True)
class QuestionAnswer:
    """One question's worth of user input.

    `selected` holds the option labels the user picked; `other_text` holds any
    free-text the user supplied (either via the "Other" choice or by typing a
    regular chat message while a question was pending).
    """

    selected: tuple[str, ...] = ()
    other_text: str | None = None


def serialize_answers(question: Question, answers: tuple[QuestionAnswer, ...]) -> str:
    """Tool-result content the LLM sees once the user answers."""
    body = {
        "status": "answered",
        "question_id": question.id,
        "answers": [
            {
                "question": q.question,
                "header": q.header,
                "selected": list(a.selected),
                "other": a.other_text,
            }
            for q, a in zip(question.questions, answers, strict=True)
        ],
    }
    return json.dumps(body)


AWAITING_STATUS = "awaiting_answer"


def awaiting_payload(question_id: str) -> str:
    """Tool-result content while the question is still open."""
    return json.dumps({"status": AWAITING_STATUS, "question_id": question_id})


def is_awaiting(content: str) -> bool:
    if not content:
        return False
    try:
        body = json.loads(content)
    except (ValueError, TypeError):
        return False
    return isinstance(body, dict) and body.get("status") == AWAITING_STATUS
