"""SQLite schema for the local cache.

Single v1 schema. The cache is a derived view of provider state — when the
schema needs to change, the on-disk file is deleted and re-synced from the
provider. `init_db()` only validates `application_id` and installs the
schema; it does not attempt to upgrade older databases.
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
        author          TEXT,
        parent_id       TEXT,
        tags_json       TEXT NOT NULL DEFAULT '[]',
        provider_raw    TEXT NOT NULL DEFAULT '{}',
        updated_at      TEXT NOT NULL,
        synced_at       TEXT NOT NULL,
        archived        INTEGER NOT NULL DEFAULT 0,
        url             TEXT,
        repository_url  TEXT
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
        provider_key        TEXT PRIMARY KEY,
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
    # Projects. A project IS a provider — name and optional description hang
    # off the provider key. Scopes are visual filters, so they don't split
    # project identity: memory, sources, sub-agents, and MCP servers are
    # shared across every scope on the provider. Rows are created lazily the
    # first time a project is touched but can be renamed / described up front
    # via `docket project rename`.
    """
    CREATE TABLE IF NOT EXISTS projects (
        id           TEXT PRIMARY KEY,
        provider_key TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL,
        archived_at  TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_projects_provider ON projects(provider_key, archived_at)",
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
    # ---------------------------------------------------------------------
    # Per-project memory: durable agent knowledge (glossary, decisions,
    # conventions). Rows belong to a project; deleting the project cascades.
    # `memory_revisions` carries a per-project counter that the prompt
    # prefix builder reads — same revision → same bytes → prompt cache hit.
    # ---------------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS memory (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        body_md     TEXT NOT NULL DEFAULT '',
        tags_json   TEXT NOT NULL DEFAULT '[]',
        source      TEXT NOT NULL DEFAULT 'user',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_memory_project_updated ON memory(project_id, updated_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS memory_revisions (
        project_id  TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        revision    INTEGER NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL
    )
    """,
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        project_id UNINDEXED,
        title,
        body_md,
        tags_concat,
        tokenize = 'unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts (memory_id, project_id, title, body_md, tags_concat)
        VALUES (new.id, new.project_id, new.title, new.body_md, COALESCE(new.tags_json, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
        INSERT INTO memory_fts (memory_id, project_id, title, body_md, tags_concat)
        VALUES (new.id, new.project_id, new.title, new.body_md, COALESCE(new.tags_json, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
    END
    """,
    # ---------------------------------------------------------------------
    # Per-project sources: human-curated reference documents. Agent has
    # read-only access; no revision counter because sources don't ride
    # in the prompt prefix on every turn. Optional `kind` (free-text)
    # is FTS-indexed so search can be narrowed by category.
    # ---------------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS sources (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        kind        TEXT NOT NULL DEFAULT '',
        uri         TEXT NOT NULL DEFAULT '',
        body_md     TEXT NOT NULL DEFAULT '',
        tags_json   TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_sources_project_updated ON sources(project_id, updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_sources_project_kind ON sources(project_id, kind)",
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
        source_id UNINDEXED,
        project_id UNINDEXED,
        title,
        kind,
        body_md,
        tags_concat,
        tokenize = 'unicode61 remove_diacritics 2'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS sources_fts_ai AFTER INSERT ON sources BEGIN
        INSERT INTO sources_fts (source_id, project_id, title, kind, body_md, tags_concat)
        VALUES (new.id, new.project_id, new.title, new.kind, new.body_md, COALESCE(new.tags_json, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS sources_fts_au AFTER UPDATE ON sources BEGIN
        DELETE FROM sources_fts WHERE source_id = old.id;
        INSERT INTO sources_fts (source_id, project_id, title, kind, body_md, tags_concat)
        VALUES (new.id, new.project_id, new.title, new.kind, new.body_md, COALESCE(new.tags_json, ''));
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS sources_fts_ad AFTER DELETE ON sources BEGIN
        DELETE FROM sources_fts WHERE source_id = old.id;
    END
    """,
    # ---------------------------------------------------------------------
    # Command palette usage counter. Used by the TUI (and eventually the
    # frontend) to float recently-used commands to the top of the list so
    # the user doesn't have to re-discover the same action every session.
    # Rows are keyed by a stable command id (not the display label, which
    # may change) and carry a usage count for future tie-breakers.
    # ---------------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS command_usage (
        id            TEXT PRIMARY KEY,
        last_used_at  TEXT NOT NULL,
        usage_count   INTEGER NOT NULL DEFAULT 1
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_command_usage_last_used ON command_usage(last_used_at DESC)",
)
