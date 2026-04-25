"""QuestionStore — staging, peek, pop, list, single-pending semantics."""

from __future__ import annotations

from docket.core.question import Question, QuestionItem, QuestionOption
from docket.core.services.question_store import QuestionStore


def _question(
    *,
    convo_id: str = "c-1",
    provider_key: str = "main",
    project_id: str = "p-1",
    tool_call_id: str = "tc-1",
) -> Question:
    return Question(
        tool_call_id=tool_call_id,
        conversation_id=convo_id,
        provider_key=provider_key,
        project_id=project_id,
        questions=(
            QuestionItem(
                question="A?",
                header="A",
                multi_select=False,
                options=(
                    QuestionOption(label="yes"),
                    QuestionOption(label="no"),
                ),
            ),
        ),
    )


def test_stage_peek_pop_roundtrip() -> None:
    store = QuestionStore()
    q = _question()
    returned_id = store.stage(q)
    assert returned_id == q.id
    assert len(store) == 1
    fetched = store.peek(("main", "p-1", "c-1"))
    assert fetched is q
    by_id = store.get(q.id)
    assert by_id is q
    popped = store.pop(("main", "p-1", "c-1"))
    assert popped is q
    assert store.peek(("main", "p-1", "c-1")) is None
    assert len(store) == 0


def test_single_pending_per_conversation_replaces_prior() -> None:
    """The last `ask_user` for a conversation wins — agents shouldn't stack
    questions, and the store mirrors that single-pending invariant."""
    store = QuestionStore()
    first = _question(tool_call_id="tc-a")
    second = _question(tool_call_id="tc-b")
    store.stage(first)
    store.stage(second)
    assert len(store) == 1
    pending = store.peek(("main", "p-1", "c-1"))
    assert pending is second


def test_distinct_conversations_keep_independent_pending() -> None:
    store = QuestionStore()
    a = _question(convo_id="c-a")
    b = _question(convo_id="c-b")
    store.stage(a)
    store.stage(b)
    assert len(store) == 2
    assert store.peek(("main", "p-1", "c-a")) is a
    assert store.peek(("main", "p-1", "c-b")) is b


def test_list_returns_all_pending_questions() -> None:
    store = QuestionStore()
    a = _question(convo_id="c-a")
    b = _question(convo_id="c-b")
    store.stage(a)
    store.stage(b)
    listed = store.list()
    assert {q.id for q in listed} == {a.id, b.id}


def test_get_returns_none_for_unknown_id() -> None:
    store = QuestionStore()
    assert store.get("missing") is None


def test_clear_drops_everything() -> None:
    store = QuestionStore()
    store.stage(_question(convo_id="c-a"))
    store.stage(_question(convo_id="c-b"))
    assert len(store) == 2
    store.clear()
    assert len(store) == 0
    assert store.list() == []
