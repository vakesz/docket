"""Ties the LLM agent loop to persistence.

Responsibilities:
- Resume the active thread for an item (or start one).
- Run a user turn end-to-end: append the user message, invoke the loop,
  persist every assistant/tool message, and update token/cost usage.
- Archive a thread (for the "new thread" keybind).

Keeps the TUI / HTTP surfaces thin: they call `send_user_message` and get
back the full `AgentTurn` plus the persisted conversation id."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass

from docket.agent.loop import AgentLoop
from docket.agent.prompt import build_prefix
from docket.agent.types import ChatMessage, StreamDelta, Usage
from docket.core.model import Conversation, Item, MemoryEntry
from docket.core.services import compaction_service
from docket.storage.db import transaction
from docket.storage.repos import (
    comment_repo,
    conversation_repo,
    item_repo,
    memory_repo,
    message_repo,
)


@dataclass
class TurnResult:
    conversation: Conversation
    final_text: str
    new_messages: list[ChatMessage]
    usage: Usage


def new_thread(conn: sqlite3.Connection, item_id: str, *, provider_key: str = "") -> Conversation:
    active = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if active is not None:
        conversation_repo.archive(conn, active.id)
    return conversation_repo.create(conn, item_id, provider_key=provider_key)


def send_user_message(
    conn: sqlite3.Connection,
    loop: AgentLoop,
    item_id: str,
    text: str,
    *,
    on_delta: Callable[[StreamDelta], None] | None = None,
    on_message: Callable[[ChatMessage], None] | None = None,
    compaction_threshold_tokens: int | None = None,
    provider_key: str = "",
    project_id: str = "",
) -> TurnResult:
    item = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if item is None:
        raise KeyError(f"unknown item '{item_id}'")
    convo = conversation_repo.get_active_for_item(
        conn, item_id, provider_key=provider_key
    ) or conversation_repo.create(conn, item_id, provider_key=provider_key)
    # Compact BEFORE building the prompt so the history we feed the model is
    # already trimmed. A just-crossed threshold collapses on this turn, not the
    # next.
    if compaction_threshold_tokens:
        compaction_service.maybe_compact(
            conn,
            llm=loop.client,
            convo_id=convo.id,
            threshold_tokens=compaction_threshold_tokens,
        )
    past = message_repo.list_for_conversation(conn, convo.id)

    prefix = _build_prefix(conn, item, project_id=project_id)
    user_msg = ChatMessage(role="user", content=text)

    turn = loop.run_turn(
        prefix=prefix,
        history=past,
        user_message=user_msg,
        on_delta=on_delta,
        on_message=on_message,
    )

    # Persist everything the turn produced. tokens land on the final assistant
    # message; all other new messages (user echo, intermediate assistant,
    # tool results) count zero so we don't double-count usage.
    with transaction(conn):
        for m in turn.new_messages:
            is_final = m is turn.final
            message_repo.append(
                conn,
                convo.id,
                m,
                tokens_in=turn.usage.tokens_in if is_final else 0,
                tokens_out=turn.usage.tokens_out if is_final else 0,
            )
        conversation_repo.add_usage(
            conn,
            convo.id,
            tokens_in=turn.usage.tokens_in,
            tokens_out=turn.usage.tokens_out,
        )

    # Re-read so tokens counters reflect the update.
    refreshed = conversation_repo.get(conn, convo.id) or convo
    return TurnResult(
        conversation=refreshed,
        final_text=turn.final.content,
        new_messages=turn.new_messages,
        usage=turn.usage,
    )


def _build_prefix(
    conn: sqlite3.Connection, item: Item, *, project_id: str = ""
) -> list[ChatMessage]:
    comments = comment_repo.list_comments(conn, item.id, provider_key=item.provider_key)
    memory: list[MemoryEntry] = []
    revision = 0
    if project_id:
        # Best-effort: a missing project (fresh DB, mid-onboarding) just means
        # no memory yet. Don't fail the chat turn over it.
        try:
            memory = memory_repo.list_for_project(conn, project_id)
            revision = memory_repo.get_revision(conn, project_id)
        except KeyError:
            memory = []
            revision = 0
    return build_prefix(item, comments, memory=memory, memory_revision=revision)
