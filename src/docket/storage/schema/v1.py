from __future__ import annotations

APPLICATION_ID = 0x49545600

STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE items (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        title           TEXT NOT NULL,
        description_md  TEXT NOT NULL DEFAULT '',
        state           TEXT NOT NULL,
        assignee        TEXT,
        parent_id       TEXT,
        tags_json       TEXT NOT NULL DEFAULT '[]',
        provider_raw    TEXT NOT NULL DEFAULT '{}',
        updated_at      TEXT NOT NULL,
        synced_at       TEXT NOT NULL,
        archived        INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX idx_items_updated_at ON items(updated_at)",
    "CREATE INDEX idx_items_kind_archived ON items(kind, archived)",
    "CREATE INDEX idx_items_parent ON items(parent_id)",
    """
    CREATE TABLE comments (
        id           TEXT PRIMARY KEY,
        item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        author       TEXT NOT NULL,
        body_md      TEXT NOT NULL,
        created_at   TEXT NOT NULL
    )
    """,
    "CREATE INDEX idx_comments_item ON comments(item_id, created_at)",
    """
    CREATE TABLE conversations (
        id            TEXT PRIMARY KEY,
        item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        started_at    TEXT NOT NULL,
        archived_at   TEXT,
        tokens_in     INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        cost_cents    INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX idx_conversations_item ON conversations(item_id, archived_at)",
    """
    CREATE TABLE messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role             TEXT NOT NULL,
        content          TEXT NOT NULL,
        tool_calls_json  TEXT,
        tokens_in        INTEGER NOT NULL DEFAULT 0,
        tokens_out       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
    )
    """,
    "CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at)",
    """
    CREATE TABLE attachments (
        id              TEXT PRIMARY KEY,
        item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        filename        TEXT NOT NULL,
        remote_url      TEXT NOT NULL,
        uploaded_at     TEXT NOT NULL
    )
    """,
    "CREATE INDEX idx_attachments_item ON attachments(item_id)",
    """
    CREATE TABLE sync_state (
        scope_key           TEXT PRIMARY KEY,
        watermark_iso       TEXT,
        last_full_sync_at   TEXT
    )
    """,
)
