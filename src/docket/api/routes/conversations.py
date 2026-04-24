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
from collections.abc import AsyncIterator
from dataclasses import asdict
from threading import Thread

from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse, ServerSentEvent  # type: ignore[attr-defined]

from docket.agent.loop import AgentLoop
from docket.agent.types import ChatMessage, StreamDelta
from docket.api.auth import require_bearer
from docket.api.deps import (
    get_active_provider_key,
    get_conn,
    get_proposals,
    get_provider,
    require_agent,
)
from docket.api.routes.items import get_item_or_fetch
from docket.api.schemas import (
    ChatRoleDTO,
    ConversationDTO,
    ConversationHistoryDTO,
    ProposalDTO,
    SendMessageRequest,
)
from docket.core.services import conversation_service
from docket.core.services.proposal_store import ProposalStore
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
    agent: AgentLoop = Depends(require_agent),
    provider_key: str = Depends(get_active_provider_key),
) -> EventSourceResponse:
    """Drive one agent turn, streaming assistant text and tool events via SSE.

    Event types emitted:
      - `delta` — assistant-text chunks (`{"text": "..."}`)
      - `message` — assistant or tool messages persisted during the turn
      - `proposal` — a staged mutation ready for confirmation (fired when the
        agent calls a mutating tool)
      - `done` — terminal, carries usage totals
      - `error` — terminal, carries a human-readable detail
    """
    get_item_or_fetch(conn, provider, item_id, provider_key)

    generator = _stream_turn(
        conn=conn,
        agent=agent,
        store=store,
        item_id=item_id,
        text=payload.text,
        request=request,
        provider_key=provider_key,
    )
    return EventSourceResponse(generator)


# -- streaming plumbing -----------------------------------------------------


async def _stream_turn(
    *,
    conn: sqlite3.Connection,
    agent: AgentLoop,
    store: ProposalStore,
    item_id: str,
    text: str,
    request: Request,
    provider_key: str,
) -> AsyncIterator[ServerSentEvent]:
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[ServerSentEvent | None] = asyncio.Queue()
    known_proposal_ids = {p.proposal.id for p in store.list()}

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


__all__ = ["router"]
