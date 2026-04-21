"""v5: FTS5 index across items + their comments.

Creates a contentless-style FTS5 virtual table keyed on `item_id` with the
item's title, description, and a concatenation of all its comments. Triggers
on `items` and `comments` keep it in sync; a backfill pass populates existing
rows so the index is immediately usable after migration.

The comments are stored as a single `group_concat(body_md, char(10))` blob
inside the FTS row — re-derived whenever either the item or any of its
comments is written. That makes every write a tiny bit heavier but lets
`MATCH` on the FTS table find items by anything said in a comment, which is
what daily triage actually needs.
"""
from __future__ import annotations

STATEMENTS: tuple[str, ...] = (
    """
    CREATE VIRTUAL TABLE items_fts USING fts5(
        item_id UNINDEXED,
        title,
        description_md,
        comments_concat,
        tokenize = 'unicode61 remove_diacritics 2'
    )
    """,
    # Backfill: index every item already in the cache.
    """
    INSERT INTO items_fts (item_id, title, description_md, comments_concat)
    SELECT
        i.id,
        i.title,
        i.description_md,
        COALESCE(
            (SELECT group_concat(body_md, char(10)) FROM comments WHERE item_id = i.id),
            ''
        )
    FROM items i
    """,
    # Item-side triggers.
    """
    CREATE TRIGGER items_fts_ai AFTER INSERT ON items BEGIN
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
    CREATE TRIGGER items_fts_au AFTER UPDATE ON items BEGIN
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
    CREATE TRIGGER items_fts_ad AFTER DELETE ON items BEGIN
        DELETE FROM items_fts WHERE item_id = old.id;
    END
    """,
    # Comment-side triggers: refresh the parent item's FTS row whenever its
    # comment set changes. Each trigger replaces the row wholesale; cheaper
    # than trying to splice in/out individual comment bodies.
    """
    CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments BEGIN
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
    CREATE TRIGGER comments_fts_au AFTER UPDATE ON comments BEGIN
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
    CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
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
