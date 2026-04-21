from __future__ import annotations

import json
import sqlite3
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
            tool_call_id, tool_name, tokens_in, tokens_out, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            datetime.now(UTC).isoformat(),
        ),
    )
    return msg_id


def list_for_conversation(conn: sqlite3.Connection, convo_id: str) -> list[ChatMessage]:
    rows = conn.execute(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC",
        (convo_id,),
    ).fetchall()
    return [_row_to_message(r) for r in rows]
