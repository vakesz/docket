"""Conversation compaction.

Long conversations stop fitting inside the model's context window (and, more
urgently, the prompt cache becomes useless once the prefix + history exceeds
the model's limit). Compaction summarizes the oldest N turns into one
`system` message pinned at the top, marks the originals with `compacted=1`
so prompt building skips them, and keeps them in SQLite for the transcript.

Trigger: `aggregate_tokens(conversation) >= threshold`. The threshold comes
from `config.llm.compaction_threshold_tokens`.

Strategy: we keep the most recent `TAIL_KEEP_MESSAGES` intact (so the live
context always has the last few turns verbatim) and summarize everything
older than that. If everything older already fits in a single summary, we're
done; otherwise we compact again on the next turn.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

from docket.agent.llm_client import LlmClient
from docket.agent.types import ChatMessage, ToolSchema
from docket.storage import transaction
from docket.storage.repos import conversation_repo, message_repo

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
    result = llm.complete(request, [])
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


# Unused but kept so callers can introspect the summary signal without parsing.
_ = ToolSchema

__all__ = [
    "SUMMARY_MARKER",
    "TAIL_KEEP_MESSAGES",
    "CompactionResult",
    "compact_now",
    "maybe_compact",
]
