"""Full-text search over the cache via SQLite FTS5 (schema v5).

`search(conn, query)` returns item ids ranked by bm25. User input is treated
as a set of prefix-matched terms implicitly AND'd together — this matches the
type-as-you-filter UX we want in the TUI's left pane without requiring users
to know FTS5 syntax.
"""
from __future__ import annotations

import re
import sqlite3

_WORD = re.compile(r"\w+", flags=re.UNICODE)


def _build_fts_query(raw: str) -> str:
    """Turn free-text user input into a safe FTS5 MATCH expression.

    Extracts word runs (same shape the unicode61 tokenizer produces on the
    indexed side), appends `*` for prefix match, and joins with spaces
    (implicit AND). Returns an empty string if nothing survives; callers
    should treat that as "no query". Splitting on non-word boundaries rather
    than whitespace means inputs like `AUTH-42` become two matchable terms
    (`AUTH*`, `42*`) that line up with how the content was tokenized.
    """
    terms = [f"{m.group(0)}*" for m in _WORD.finditer(raw)]
    return " ".join(terms)


def search(conn: sqlite3.Connection, query: str) -> list[str]:
    """Return item ids matching `query`, ranked best-first.

    Empty/blank query returns []. On FTS5 syntax or tokenizer failure we fall
    back to a LIKE scan across title + description + comments_concat so the
    caller always gets a best-effort answer."""
    stripped = query.strip()
    if not stripped:
        return []
    fts_query = _build_fts_query(stripped)
    if fts_query:
        try:
            rows = conn.execute(
                "SELECT item_id FROM items_fts WHERE items_fts MATCH ? ORDER BY rank",
                (fts_query,),
            ).fetchall()
            return [r[0] for r in rows]
        except sqlite3.OperationalError:
            # FTS5 can reject things its tokenizer doesn't like; fall through
            # to the LIKE branch rather than hiding the result set entirely.
            pass
    like = f"%{stripped}%"
    rows = conn.execute(
        """
        SELECT DISTINCT item_id
        FROM items_fts
        WHERE title LIKE ? OR description_md LIKE ? OR comments_concat LIKE ?
        """,
        (like, like, like),
    ).fetchall()
    return [r[0] for r in rows]
