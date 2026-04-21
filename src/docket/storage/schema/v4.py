"""v4: mark compacted messages on the `messages` table.

Once a conversation crosses the compaction threshold, older turns are
summarized into a single `system` message and the originals get
`compacted = 1`. Prompt building skips compacted rows; transcript uploads
keep them so the audit is unbroken.
"""
from __future__ import annotations

STATEMENTS: tuple[str, ...] = (
    "ALTER TABLE messages ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0",
    "CREATE INDEX idx_messages_live ON messages(conversation_id, compacted, created_at)",
)
