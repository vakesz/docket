"""SQLite schema for the local cache.

Single-file schema. Docket supports one cache schema version at a time; if
an older cache is detected, `init_db()` recreates it instead of migrating.
"""

from __future__ import annotations

APPLICATION_ID = 0x49545600
SCHEMA_VERSION = 1

STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS items (
        id              TEXT PRIMARY KEY,
        provider_key    TEXT NOT NULL,
        provider_item_id TEXT NOT NULL,
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
        archived        INTEGER NOT NULL DEFAULT 0,
        url             TEXT
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_items_provider_item ON items(provider_key, provider_item_id)",
    "CREATE INDEX IF NOT EXISTS idx_items_provider_updated_at ON items(provider_key, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_items_provider_kind_archived ON items(provider_key, kind, archived)",
    "CREATE INDEX IF NOT EXISTS idx_items_provider_parent ON items(provider_key, parent_id)",
    """
    CREATE TABLE IF NOT EXISTS comments (
        id           TEXT NOT NULL,
        item_id      TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        author       TEXT NOT NULL,
        body_md      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (item_id, id)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id, created_at)",
    """
    CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        item_id       TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        started_at    TEXT NOT NULL,
        archived_at   TEXT,
        tokens_in     INTEGER NOT NULL DEFAULT 0,
        tokens_out    INTEGER NOT NULL DEFAULT 0,
        cost_cents    INTEGER NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_conversations_item ON conversations(item_id, archived_at)",
    """
    CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role             TEXT NOT NULL,
        content          TEXT NOT NULL,
        tool_calls_json  TEXT,
        tool_call_id     TEXT,
        tool_name        TEXT,
        compacted        INTEGER NOT NULL DEFAULT 0,
        tokens_in        INTEGER NOT NULL DEFAULT 0,
        tokens_out       INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_messages_live ON messages(conversation_id, compacted, created_at)",
    """
    CREATE TABLE IF NOT EXISTS attachments (
        id              TEXT PRIMARY KEY,
        item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        filename        TEXT NOT NULL,
        remote_url      TEXT NOT NULL,
        uploaded_at     TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_attachments_item ON attachments(item_id)",
    """
    CREATE TABLE IF NOT EXISTS sync_state (
        scope_key           TEXT PRIMARY KEY,
        watermark_iso       TEXT,
        last_full_sync_at   TEXT
    )
    """,
    # Watchlist. No FK to `items(id)` on purpose — pinning an id that is
    # temporarily outside the active scope is a valid state; the render join
    # just quietly excludes that row until the next sync re-adds it.
    """
    CREATE TABLE IF NOT EXISTS watchlist (
        id         TEXT PRIMARY KEY,
        pinned_at  TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_watchlist_pinned_at ON watchlist(pinned_at DESC)",
    # FTS5 index across items + their comments. Comments are stored as a
    # single `group_concat(body_md, char(10))` blob re-derived whenever the
    # item or any of its comments is written.
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        item_id UNINDEXED,
        title,
        description_md,
        comments_concat,
        tokenize = 'unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts (item_id, title, description_md, comments_concat)
        VALUES (
            new.id,
            new.title,
            new.description_md,
            COALESCE(
                (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = new.id),
                ''
            )
        );
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
        DELETE FROM items_fts WHERE item_id = old.id;
        INSERT INTO items_fts (item_id, title, description_md, comments_concat)
        VALUES (
            new.id,
            new.title,
            new.description_md,
            COALESCE(
                (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = new.id),
                ''
            )
        );
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
        DELETE FROM items_fts WHERE item_id = old.id;
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS comments_fts_ai AFTER INSERT ON comments BEGIN
        DELETE FROM items_fts WHERE item_id = new.item_id;
        INSERT INTO items_fts (item_id, title, description_md, comments_concat)
        SELECT
            i.id,
            i.title,
            i.description_md,
            COALESCE(
                (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = i.id),
                ''
            )
        FROM items i WHERE i.id = new.item_id;
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS comments_fts_au AFTER UPDATE ON comments BEGIN
        DELETE FROM items_fts WHERE item_id = new.item_id;
        INSERT INTO items_fts (item_id, title, description_md, comments_concat)
        SELECT
            i.id,
            i.title,
            i.description_md,
            COALESCE(
                (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = i.id),
                ''
            )
        FROM items i WHERE i.id = new.item_id;
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS comments_fts_ad AFTER DELETE ON comments BEGIN
        DELETE FROM items_fts WHERE item_id = old.item_id;
        INSERT INTO items_fts (item_id, title, description_md, comments_concat)
        SELECT
            i.id,
            i.title,
            i.description_md,
            COALESCE(
                (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = i.id),
                ''
            )
        FROM items i WHERE i.id = old.item_id;
    END
    """,
)
