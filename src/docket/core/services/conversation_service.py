"""Ties the LLM agent loop to persistence.

Responsibilities:
- Resume the active thread for an item (or start one).
- Run a user turn end-to-end: append the user message, invoke the loop,
  persist every assistant/tool message, and update token/cost usage.
- Archive a thread (for the "new thread" keybind).
- Resume a turn after the user answers a staged `ask_user` question.
- Compact older messages into a pinned summary when aggregate tokens cross a
  configured threshold (so the prompt cache and context window survive long
  threads).

Keeps the TUI / HTTP surfaces thin: they call `send_user_message` and get
back the full `AgentTurn` plus the persisted conversation id."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from docket.agent.llm_client import LlmClient, accumulate_stream
from docket.agent.loop import AgentLoop, AgentTurn
from docket.agent.prompt import build_prefix
from docket.agent.types import ChatMessage, StreamDelta, Usage
from docket.core.model import Conversation, Item, MemoryEntry
from docket.core.question import (
    Question,
    QuestionAnswer,
    serialize_answers,
)
from docket.core.services.question_store import QuestionStore
from docket.storage.db import transaction
from docket.storage.repos import (
    comment_repo,
    conversation_repo,
    item_repo,
    memory_repo,
    message_repo,
)

TAIL_KEEP_MESSAGES = 6
SUMMARY_MARKER = "[conversation-summary]"
_SUMMARY_PROMPT = (
    "You are summarizing the earlier part of a work-item triage conversation.\n"
    "Produce a terse, fact-dense summary that a future assistant turn can rely on.\n"
    "Rules:\n"
    "- Preserve any open questions, decisions, and proposals made.\n"
    "- Reference ticket ids and tool results by id; do not re-quote long text.\n"
    "- Do not invent anything that was not in the transcript.\n"
    "- Under 400 words.\n"
)


@dataclass
class CompactionResult:
    conversation_id: str
    compacted_message_count: int
    summary_message_id: str | None  # None if nothing to compact


def maybe_compact(
    conn: sqlite3.Connection,
    *,
    llm: LlmClient,
    convo_id: str,
    threshold_tokens: int,
) -> CompactionResult:
    """Compact if the conversation's aggregate tokens are at or above the
    threshold. Returns the result of the run (including when nothing happens)."""
    convo = conversation_repo.get(conn, convo_id)
    if convo is None:
        raise KeyError(f"unknown conversation '{convo_id}'")
    aggregate = convo.tokens_in + convo.tokens_out
    if aggregate < threshold_tokens:
        return CompactionResult(
            conversation_id=convo_id,
            compacted_message_count=0,
            summary_message_id=None,
        )
    return compact_now(conn, llm=llm, convo_id=convo_id)


def compact_now(
    conn: sqlite3.Connection,
    *,
    llm: LlmClient,
    convo_id: str,
    tail_keep: int = TAIL_KEEP_MESSAGES,
) -> CompactionResult:
    """Force a compaction regardless of token count. Useful for tests."""
    rows = message_repo.list_rows_for_conversation(conn, convo_id, live_only=True)
    if len(rows) <= tail_keep + 1:  # need at least 2 rows to compact to a summary
        return CompactionResult(
            conversation_id=convo_id,
            compacted_message_count=0,
            summary_message_id=None,
        )

    head_rows = rows[:-tail_keep] if tail_keep > 0 else rows
    if not head_rows:
        return CompactionResult(
            conversation_id=convo_id,
            compacted_message_count=0,
            summary_message_id=None,
        )
    head_ids = [r["id"] for r in head_rows]
    head_messages = [message_repo.row_to_message(r) for r in head_rows]

    summary_text = _summarize(llm, head_messages)
    summary_msg = ChatMessage(role="system", content=f"{SUMMARY_MARKER}\n{summary_text}")

    # Pin the summary ahead of the oldest compacted row so ORDER BY created_at
    # ASC puts it at the top of the live transcript.
    earliest = datetime.fromisoformat(head_rows[0]["created_at"])
    summary_created_at = earliest - timedelta(microseconds=1)

    with transaction(conn):
        summary_id = message_repo.append(conn, convo_id, summary_msg, created_at=summary_created_at)
        message_repo.mark_compacted(conn, head_ids)

    return CompactionResult(
        conversation_id=convo_id,
        compacted_message_count=len(head_ids),
        summary_message_id=summary_id,
    )


def _summarize(llm: LlmClient, messages: list[ChatMessage]) -> str:
    """Ask the LLM for a terse summary of the given messages. The summarization
    is a one-shot non-streaming call with no tools."""
    rendered = _render_for_summary(messages)
    request: list[ChatMessage] = [
        ChatMessage(role="system", content=_SUMMARY_PROMPT),
        ChatMessage(role="user", content=rendered),
    ]
    result = accumulate_stream(llm.stream(request, []))
    return result.message.content.strip()


def _render_for_summary(messages: list[ChatMessage]) -> str:
    lines: list[str] = []
    for m in messages:
        if m.role == "tool":
            lines.append(f"[tool:{m.name}] {m.content}")
        elif m.role == "assistant" and m.tool_calls:
            calls = ", ".join(f"{tc.name}({tc.arguments})" for tc in m.tool_calls)
            if m.content:
                lines.append(f"[assistant] {m.content}")
            lines.append(f"[assistant:tool_call] {calls}")
        else:
            prefix = f"[{m.role}]"
            lines.append(f"{prefix} {m.content}")
    return "\n".join(lines)


@dataclass
class TurnResult:
    conversation: Conversation
    final_text: str
    new_messages: list[ChatMessage]
    usage: Usage
    pending_question: Question | None = None


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
    question_store: QuestionStore | None = None,
) -> TurnResult:
    item = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if item is None:
        raise KeyError(f"unknown item '{item_id}'")
    convo = conversation_repo.get_active_for_item(
        conn, item_id, provider_key=provider_key
    ) or conversation_repo.create(conn, item_id, provider_key=provider_key)

    # Pending question? Treat the user's free text as the answer. The first
    # question receives the typed text as `other_text`; the rest are left
    # blank so the agent can re-ask if needed.
    if question_store is not None:
        pending = question_store.peek((provider_key, project_id, convo.id))
        if pending is not None:
            answers = tuple(
                QuestionAnswer(other_text=text) if idx == 0 else QuestionAnswer()
                for idx, _ in enumerate(pending.questions)
            )
            return submit_question_answer(
                conn,
                loop,
                item_id,
                pending.id,
                answers,
                on_delta=on_delta,
                on_message=on_message,
                compaction_threshold_tokens=compaction_threshold_tokens,
                provider_key=provider_key,
                project_id=project_id,
                question_store=question_store,
            )

    # Compact BEFORE building the prompt so the history we feed the model is
    # already trimmed. A just-crossed threshold collapses on this turn, not the
    # next.
    if compaction_threshold_tokens:
        maybe_compact(
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
        conversation_id=convo.id,
    )

    pending_question = _persist_turn(
        conn,
        convo.id,
        turn,
        provider_key=provider_key,
        project_id=project_id,
        question_store=question_store,
    )

    # Re-read so tokens counters reflect the update.
    refreshed = conversation_repo.get(conn, convo.id) or convo
    return TurnResult(
        conversation=refreshed,
        final_text=turn.final.content,
        new_messages=turn.new_messages,
        usage=turn.usage,
        pending_question=pending_question,
    )


def submit_question_answer(
    conn: sqlite3.Connection,
    loop: AgentLoop,
    item_id: str,
    question_id: str,
    answers: tuple[QuestionAnswer, ...],
    *,
    on_delta: Callable[[StreamDelta], None] | None = None,
    on_message: Callable[[ChatMessage], None] | None = None,
    compaction_threshold_tokens: int | None = None,
    provider_key: str = "",
    project_id: str = "",
    question_store: QuestionStore,
) -> TurnResult:
    """Resume a turn after the user answers a pending `ask_user` question.

    Replaces the placeholder tool-result with the structured answers, clears
    the pending question, then runs the loop again so the agent can react to
    the answer in the same conversation."""
    item = item_repo.get_item(conn, item_id, provider_key=provider_key)
    if item is None:
        raise KeyError(f"unknown item '{item_id}'")
    convo = conversation_repo.get_active_for_item(conn, item_id, provider_key=provider_key)
    if convo is None:
        raise KeyError("no active conversation")
    key = (provider_key, project_id, convo.id)
    pending = question_store.peek(key)
    if pending is None or pending.id != question_id:
        raise KeyError(f"no pending question with id '{question_id}'")
    if len(answers) != len(pending.questions):
        raise ValueError(f"expected {len(pending.questions)} answers, got {len(answers)}")

    row = message_repo.find_pending_tool_result(conn, convo.id, pending.tool_call_id)
    if row is None:
        # Defensive: the question is in-memory but the placeholder row is
        # missing (e.g. DB recovered from backup). Drop the question.
        question_store.pop(key)
        raise KeyError("placeholder tool-result missing for pending question")

    answer_content = serialize_answers(pending, answers)
    with transaction(conn):
        message_repo.mark_tool_result_answered(conn, row["id"], answer_content)
    question_store.pop(key)

    if compaction_threshold_tokens:
        maybe_compact(
            conn,
            llm=loop.client,
            convo_id=convo.id,
            threshold_tokens=compaction_threshold_tokens,
        )
    past = message_repo.list_for_conversation(conn, convo.id)

    # `past` already contains the tool-result we just rewrote. The loop only
    # needs the prefix + history; there is no fresh user message. Synthesize
    # a no-op anchor and immediately drop it back out: the easiest way is to
    # take history minus the trailing tool-result as the working "history",
    # and feed the tool-result as the "user_message" slot. But the loop's
    # contract treats user_message as role='user' echo; cleanest fix is to
    # run the loop with the last tool-result as the trailing message.
    prefix = _build_prefix(conn, item, project_id=project_id)
    if not past:
        raise KeyError("conversation history empty after answer")
    trailing = past[-1]
    history_minus_trailing = past[:-1]
    turn = loop.run_turn(
        prefix=prefix,
        history=history_minus_trailing,
        user_message=trailing,
        on_delta=on_delta,
        on_message=on_message,
        conversation_id=convo.id,
    )
    # Drop the echoed trailing message; it is already persisted.
    if turn.new_messages and turn.new_messages[0] is trailing:
        turn.new_messages = turn.new_messages[1:]

    pending_question = _persist_turn(
        conn,
        convo.id,
        turn,
        provider_key=provider_key,
        project_id=project_id,
        question_store=question_store,
    )

    refreshed = conversation_repo.get(conn, convo.id) or convo
    return TurnResult(
        conversation=refreshed,
        final_text=turn.final.content,
        new_messages=turn.new_messages,
        usage=turn.usage,
        pending_question=pending_question,
    )


def _persist_turn(
    conn: sqlite3.Connection,
    convo_id: str,
    turn: AgentTurn,
    *,
    provider_key: str,
    project_id: str,
    question_store: QuestionStore | None,
) -> Question | None:
    """Persist all new messages from a turn, marking the trailing tool-result
    as `pending=1` when the turn ended on an `ask_user` call. Returns the
    staged Question if any."""
    pending_question: Question | None = None
    if turn.awaiting_answer and question_store is not None:
        pending_question = question_store.peek((provider_key, project_id, convo_id))
    trailing_tool_result_id = (
        turn.new_messages[-1].tool_call_id if turn.awaiting_answer and turn.new_messages else None
    )
    with transaction(conn):
        for m in turn.new_messages:
            is_final = m is turn.final
            is_pending = (
                turn.awaiting_answer
                and m.role == "tool"
                and m.tool_call_id == trailing_tool_result_id
            )
            message_repo.append(
                conn,
                convo_id,
                m,
                tokens_in=turn.usage.tokens_in if is_final else 0,
                tokens_out=turn.usage.tokens_out if is_final else 0,
                pending=is_pending,
            )
        conversation_repo.add_usage(
            conn,
            convo_id,
            tokens_in=turn.usage.tokens_in,
            tokens_out=turn.usage.tokens_out,
        )
    return pending_question


def _build_prefix(
    conn: sqlite3.Connection, item: Item, *, project_id: str = ""
) -> list[ChatMessage]:
    comments = comment_repo.list_comments(conn, item.id, provider_key=item.provider_key)
    memory: list[MemoryEntry] = []
    if project_id:
        # Best-effort: a missing project (fresh DB, mid-onboarding) just means
        # no memory yet. Don't fail the chat turn over it.
        try:
            memory = memory_repo.list_for_project(conn, project_id)
        except KeyError:
            memory = []
    return build_prefix(item, comments, memory=memory)
