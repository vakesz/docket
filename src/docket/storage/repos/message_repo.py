from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from datetime import UTC, datetime
from uuid import uuid4

from docket.agent.types import ChatMessage, ToolCall


def _row_to_message(row: sqlite3.Row) -> ChatMessage:
    tool_calls_raw = row["tool_calls_json"]
    tool_calls: list[ToolCall] = []
    if tool_calls_raw:
        for tc in json.loads(tool_calls_raw):
            args = tc.get("arguments") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            tool_calls.append(
                ToolCall(
                    id=str(tc.get("id", "")),
                    name=str(tc.get("name", "")),
                    arguments=args if isinstance(args, dict) else {},
                )
            )
    return ChatMessage(
        role=row["role"],
        content=row["content"] or "",
        tool_calls=tool_calls,
        tool_call_id=row["tool_call_id"],
        name=row["tool_name"],
    )


def append(
    conn: sqlite3.Connection,
    convo_id: str,
    message: ChatMessage,
    *,
    tokens_in: int = 0,
    tokens_out: int = 0,
    created_at: datetime | None = None,
) -> str:
    msg_id = str(uuid4())
    tool_calls_json: str | None = None
    if message.tool_calls:
        tool_calls_json = json.dumps(
            [
                {"id": tc.id, "name": tc.name, "arguments": tc.arguments}
                for tc in message.tool_calls
            ]
        )
    conn.execute(
        """
        INSERT INTO messages (
            id, conversation_id, role, content, tool_calls_json,
            tool_call_id, tool_name, tokens_in, tokens_out, created_at, compacted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        """,
        (
            msg_id,
            convo_id,
            message.role,
            message.content,
            tool_calls_json,
            message.tool_call_id,
            message.name,
            tokens_in,
            tokens_out,
            (created_at or datetime.now(UTC)).isoformat(),
        ),
    )
    return msg_id


def list_for_conversation(
    conn: sqlite3.Connection, convo_id: str, *, live_only: bool = True
) -> list[ChatMessage]:
    """Return messages for a conversation.

    `live_only=True` (the default) skips rows that were folded into a summary
    by compaction. Transcript upload flips it off so nothing is lost."""
    sql = "SELECT * FROM messages WHERE conversation_id = ?"
    params: list[object] = [convo_id]
    if live_only:
        sql += " AND compacted = 0"
    sql += " ORDER BY created_at ASC, id ASC"
    rows = conn.execute(sql, params).fetchall()
    return [_row_to_message(r) for r in rows]


def list_rows_for_conversation(
    conn: sqlite3.Connection, convo_id: str, *, live_only: bool = True
) -> list[sqlite3.Row]:
    """Row-level access: callers that need ids/created_at as well as the
    ChatMessage payload. Used by compaction to pick a boundary and flip flags."""
    sql = "SELECT * FROM messages WHERE conversation_id = ?"
    params: list[object] = [convo_id]
    if live_only:
        sql += " AND compacted = 0"
    sql += " ORDER BY created_at ASC, id ASC"
    return list(conn.execute(sql, params).fetchall())


def mark_compacted(conn: sqlite3.Connection, ids: Iterable[str]) -> int:
    ids_list = list(ids)
    if not ids_list:
        return 0
    placeholders = ",".join("?" for _ in ids_list)
    cur = conn.execute(
        f"UPDATE messages SET compacted = 1 WHERE id IN ({placeholders})", ids_list
    )
    return cur.rowcount


def row_to_message(row: sqlite3.Row) -> ChatMessage:
    """Public alias for callers that already loaded rows directly."""
    return _row_to_message(row)
