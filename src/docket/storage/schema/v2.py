"""v2: LLM tool-result columns on messages.

A tool-role message must carry the tool_call_id it replies to and the tool
name so we can send it back to the model on the next turn. v1 stored tool
calls as JSON but had no place for these. Adding nullable columns is a cheap
forward-only change.
"""
from __future__ import annotations

STATEMENTS: tuple[str, ...] = (
    "ALTER TABLE messages ADD COLUMN tool_call_id TEXT",
    "ALTER TABLE messages ADD COLUMN tool_name TEXT",
)
