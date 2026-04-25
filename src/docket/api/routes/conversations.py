"""Conversation endpoints — history, new-thread, and SSE-streamed user turns.

The agent loop is synchronous, so we run `send_user_message` in a worker thread
and pipe its `on_delta` / `on_message` callbacks back onto an asyncio.Queue. A
small sse-starlette generator drains the queue and emits events. Terminal
events — `done` on success, `error` on failure — let clients close cleanly."""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from collections.abc import AsyncIterator, Callable
from dataclasses import asdict
from threading import Thread

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sse_starlette.sse import EventSourceResponse, ServerSentEvent  # type: ignore[attr-defined]

from docket.agent.loop import AgentLoop
from docket.agent.types import ChatMessage, StreamDelta
from docket.api.auth import require_bearer
from docket.api.deps import (
    get_active_provider_key,
    get_conn,
    get_proposals,
    get_provider,
    get_questions,
    require_agent,
)
from docket.api.routes.items import get_item_or_fetch
from docket.api.schemas import (
    AnswerQuestionRequest,
    ChatRoleDTO,
    ConversationDTO,
    ConversationHistoryDTO,
    ProposalDTO,
    QuestionDTO,
    QuestionItemDTO,
    QuestionOptionDTO,
    SendMessageRequest,
)
from docket.core.question import Question, QuestionAnswer, serialize_question
from docket.core.services import conversation_service
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.question_store import QuestionStore
from docket.providers.base import WorkItemProvider
from docket.storage.repos import conversation_repo, message_repo

log = logging.getLogger(__name__)

router = APIRouter(
    prefix="/items/{item_id:path}/conversation",
    tags=["conversations"],
    dependencies=[Depends(require_bearer)],
)


def _message_dto(m: ChatMessage) -> ChatRoleDTO:
    return ChatRoleDTO(
        role=m.role,
        content=m.content,
        tool_calls=[
            {"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in m.tool_calls
        ],
        tool_call_id=m.tool_call_id,
        name=m.name,
    )


def _question_dto(q: Question) -> QuestionDTO:
    payload = serialize_question(q)
    return QuestionDTO(
        id=payload["id"],
        tool_call_id=payload["tool_call_id"],
        questions=[
            QuestionItemDTO(
                question=item["question"],
                header=item["header"],
                multi_select=item["multi_select"],
                allow_other=item["allow_other"],
                options=[
                    QuestionOptionDTO(label=o["label"], description=o["description"])
                    for o in item["options"]
                ],
            )
            for item in payload["questions"]
        ],
    )


@router.get("", response_model=ConversationHistoryDTO)
def get_history(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    provider_key: str = Depends(get_active_provider_key),
) -> ConversationHistoryDTO:
    get_item_or_fetch(conn, provider, item_id, provider_key)
    convo = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if convo is None:
        return ConversationHistoryDTO(conversation=None, messages=[])
    history = message_repo.list_for_conversation(conn, convo.id)
    return ConversationHistoryDTO(
        conversation=ConversationDTO.from_core(convo),
        messages=[_message_dto(m) for m in history],
    )


@router.get("/pending_question", response_model=QuestionDTO | None)
def get_pending_question(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    questions: QuestionStore = Depends(get_questions),
    provider_key: str = Depends(get_active_provider_key),
) -> QuestionDTO | None:
    """The pending `ask_user` question for the active conversation, or null.

    Lets the UI re-render the question card after a page reload — the
    placeholder tool-result message is in history, but the structured options
    only live in memory until the user answers."""
    get_item_or_fetch(conn, provider, item_id, provider_key)
    convo = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if convo is None:
        return None
    pending = questions.peek((provider_key, "", convo.id))
    if pending is None:
        # Fall back to scanning the store for this conversation across project
        # keys — the dep doesn't surface project_id.
        for q in questions.list():
            if q.conversation_id == convo.id:
                pending = q
                break
    if pending is None:
        return None
    return _question_dto(pending)


@router.post("/thread", response_model=ConversationDTO)
def start_thread(
    item_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    provider_key: str = Depends(get_active_provider_key),
) -> ConversationDTO:
    get_item_or_fetch(conn, provider, item_id, provider_key)
    convo = conversation_service.new_thread(conn, item_id, provider_key=provider_key)
    return ConversationDTO.from_core(convo)


@router.post("/messages")
async def send_message(
    item_id: str,
    payload: SendMessageRequest,
    request: Request,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    store: ProposalStore = Depends(get_proposals),
    questions: QuestionStore = Depends(get_questions),
    agent: AgentLoop = Depends(require_agent),
    provider_key: str = Depends(get_active_provider_key),
) -> EventSourceResponse:
    """Drive one agent turn, streaming assistant text and tool events via SSE.

    Event types emitted:
      - `delta` — assistant-text chunks (`{"text": "..."}`)
      - `message` — assistant or tool messages persisted during the turn
      - `proposal` — a staged mutation ready for confirmation (fired when the
        agent calls a mutating tool)
      - `question` — a staged `ask_user` question awaiting user input
      - `done` — terminal, carries usage totals
      - `error` — terminal, carries a human-readable detail
    """
    get_item_or_fetch(conn, provider, item_id, provider_key)

    generator = _stream_turn(
        conn=conn,
        agent=agent,
        store=store,
        questions=questions,
        item_id=item_id,
        text=payload.text,
        request=request,
        provider_key=provider_key,
    )
    return EventSourceResponse(generator)


@router.post("/answer")
async def answer_question(
    item_id: str,
    payload: AnswerQuestionRequest,
    request: Request,
    conn: sqlite3.Connection = Depends(get_conn),
    provider: WorkItemProvider = Depends(get_provider),
    store: ProposalStore = Depends(get_proposals),
    questions: QuestionStore = Depends(get_questions),
    agent: AgentLoop = Depends(require_agent),
    provider_key: str = Depends(get_active_provider_key),
) -> EventSourceResponse:
    """Resume the agent loop with the user's answer to a pending `ask_user`.

    Streams the same event types as `/messages` (delta/message/proposal/question/done/error).
    Returns 409 if no question is pending or the id does not match.
    """
    get_item_or_fetch(conn, provider, item_id, provider_key)
    convo = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if convo is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "No active conversation.")
    pending = questions.peek((provider_key, "", convo.id))
    # Match across project keys — server doesn't have project_id on this dep,
    # so fall back to a global lookup if the keyed peek missed.
    if pending is None or pending.id != payload.question_id:
        pending = questions.get(payload.question_id)
    if pending is None or pending.conversation_id != convo.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "No pending question with that id.")
    if len(payload.answers) != len(pending.questions):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Expected {len(pending.questions)} answers, got {len(payload.answers)}.",
        )

    answers = tuple(
        QuestionAnswer(selected=tuple(a.selected), other_text=a.other)
        for a in payload.answers
    )

    generator = _stream_answer(
        conn=conn,
        agent=agent,
        store=store,
        questions=questions,
        item_id=item_id,
        question_id=payload.question_id,
        answers=answers,
        request=request,
        provider_key=provider_key,
        project_id=pending.project_id,
    )
    return EventSourceResponse(generator)


# -- streaming plumbing -----------------------------------------------------


def _make_callbacks(
    *,
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue[ServerSentEvent | None],
    store: ProposalStore,
    questions: QuestionStore,
) -> tuple[
    Callable[[StreamDelta], None],
    Callable[[ChatMessage], None],
]:
    """Build delta/message callbacks that push SSE events onto `queue`.

    Tracks proposal/question ids seen at start so re-runs only emit *new*
    ones — the stores are process-global and may already hold entries from
    other conversations."""
    known_proposal_ids = {p.proposal.id for p in store.list()}
    known_question_ids = {q.id for q in questions.list()}

    def _put_threadsafe(event: ServerSentEvent | None) -> None:
        # Callbacks fire inside the worker thread; the queue is bound to the
        # request's event loop, so hop threads for every enqueue.
        asyncio.run_coroutine_threadsafe(queue.put(event), loop)

    def on_delta(delta: StreamDelta) -> None:
        if delta.text:
            _put_threadsafe(ServerSentEvent(event="delta", data=json.dumps({"text": delta.text})))

    def on_message(msg: ChatMessage) -> None:
        _put_threadsafe(
            ServerSentEvent(
                event="message",
                data=json.dumps(_message_dto(msg).model_dump(mode="json")),
            )
        )
        # A tool call may have added a pending proposal — surface it.
        for pending in store.list():
            if pending.proposal.id in known_proposal_ids:
                continue
            known_proposal_ids.add(pending.proposal.id)
            _put_threadsafe(
                ServerSentEvent(
                    event="proposal",
                    data=json.dumps(
                        ProposalDTO.from_core(pending.proposal).model_dump(mode="json")
                    ),
                )
            )
        # Same shape for `ask_user`: a tool call may have staged a question.
        for q in questions.list():
            if q.id in known_question_ids:
                continue
            known_question_ids.add(q.id)
            _put_threadsafe(
                ServerSentEvent(
                    event="question",
                    data=json.dumps(_question_dto(q).model_dump(mode="json")),
                )
            )

    return on_delta, on_message


async def _stream_turn(
    *,
    conn: sqlite3.Connection,
    agent: AgentLoop,
    store: ProposalStore,
    questions: QuestionStore,
    item_id: str,
    text: str,
    request: Request,
    provider_key: str,
) -> AsyncIterator[ServerSentEvent]:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[ServerSentEvent | None] = asyncio.Queue()
    on_delta, on_message = _make_callbacks(
        loop=loop, queue=queue, store=store, questions=questions
    )

    def _put_threadsafe(event: ServerSentEvent | None) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(event), loop)

    threshold = getattr(request.app.state, "compaction_threshold_tokens", 0) or None

    def run_turn() -> None:
        try:
            result = conversation_service.send_user_message(
                conn,
                agent,
                item_id,
                text,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=threshold,
                provider_key=provider_key,
                question_store=questions,
            )
            _put_threadsafe(
                ServerSentEvent(event="done", data=json.dumps({"usage": asdict(result.usage)}))
            )
        except Exception as e:
            log.exception("chat turn failed for %s", item_id)
            _put_threadsafe(
                ServerSentEvent(
                    event="error",
                    data=json.dumps({"detail": f"{type(e).__name__}: {e}"}),
                )
            )
        finally:
            _put_threadsafe(None)  # sentinel: stream closed

    worker = Thread(target=run_turn, daemon=True, name=f"chat-turn-{item_id}")
    worker.start()

    try:
        while True:
            if await request.is_disconnected():
                return
            event = await queue.get()
            if event is None:
                return
            yield event
    finally:
        # Worker may still be running if the client disconnected mid-turn; it
        # finishes on its own and its final enqueues land on a queue nobody
        # reads, which is harmless (queue is garbage-collected with the task).
        pass


async def _stream_answer(
    *,
    conn: sqlite3.Connection,
    agent: AgentLoop,
    store: ProposalStore,
    questions: QuestionStore,
    item_id: str,
    question_id: str,
    answers: tuple[QuestionAnswer, ...],
    request: Request,
    provider_key: str,
    project_id: str,
) -> AsyncIterator[ServerSentEvent]:
    """SSE pump for `/answer` — same event types as `_stream_turn`, but the
    worker resumes the loop via `submit_question_answer` instead of starting a
    fresh user turn."""
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[ServerSentEvent | None] = asyncio.Queue()
    on_delta, on_message = _make_callbacks(
        loop=loop, queue=queue, store=store, questions=questions
    )

    def _put_threadsafe(event: ServerSentEvent | None) -> None:
        asyncio.run_coroutine_threadsafe(queue.put(event), loop)

    threshold = getattr(request.app.state, "compaction_threshold_tokens", 0) or None

    def run_turn() -> None:
        try:
            result = conversation_service.submit_question_answer(
                conn,
                agent,
                item_id,
                question_id,
                answers,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=threshold,
                provider_key=provider_key,
                project_id=project_id,
                question_store=questions,
            )
            _put_threadsafe(
                ServerSentEvent(event="done", data=json.dumps({"usage": asdict(result.usage)}))
            )
        except Exception as e:
            log.exception("answer resume failed for %s", item_id)
            _put_threadsafe(
                ServerSentEvent(
                    event="error",
                    data=json.dumps({"detail": f"{type(e).__name__}: {e}"}),
                )
            )
        finally:
            _put_threadsafe(None)

    worker = Thread(target=run_turn, daemon=True, name=f"chat-answer-{item_id}")
    worker.start()

    try:
        while True:
            if await request.is_disconnected():
                return
            event = await queue.get()
            if event is None:
                return
            yield event
    finally:
        pass


__all__ = ["router"]
