"""Full-text search over the cache via SQLite FTS5 (schema v5).

`search(conn, query)` returns item ids ranked by bm25. User input is treated
as a set of prefix-matched terms implicitly AND'd together — this matches the
type-as-you-filter UX we want in the TUI's left pane without requiring users
to know FTS5 syntax.
"""

from __future__ import annotations

import re
import sqlite3

from docket.storage.item_keys import item_id_from_storage_key

_WORD = re.compile(r"\w+", flags=re.UNICODE)


def _terms(raw: str) -> list[str]:
    return [f"{m.group(0)}*" for m in _WORD.finditer(raw)]


def _build_fts_query(raw: str) -> str:
    """Turn free-text user input into a safe FTS5 MATCH expression.

    Extracts word runs (same shape the unicode61 tokenizer produces on the
    indexed side), appends `*` for prefix match, and joins with spaces
    (implicit AND). Returns an empty string if nothing survives; callers
    should treat that as "no query". Splitting on non-word boundaries rather
    than whitespace means inputs like `AUTH-42` become two matchable terms
    (`AUTH*`, `42*`) that line up with how the content was tokenized.
    """
    return " ".join(_terms(raw))


def _decode_ids(rows: list[sqlite3.Row]) -> list[str]:
    return [item_id_from_storage_key(row[0]) for row in rows]


def search(
    conn: sqlite3.Connection,
    query: str,
    *,
    provider_key: str | None = None,
    assignee: str | None = None,
) -> list[str]:
    """Return item ids matching `query`, ranked best-first.

    `assignee` is a post-cache visual filter — resolved `@me` identity or
    any exact assignee string. `None`/empty means "no narrowing".

    Empty/blank query returns []. On FTS5 syntax or tokenizer failure we fall
    back to a LIKE scan across title + description + comments_concat so the
    caller always gets a best-effort answer."""
    stripped = query.strip()
    if not stripped:
        return []
    extra_clauses: list[str] = []
    extra_params: list[object] = []
    if provider_key:
        extra_clauses.append("i.provider_key = ?")
        extra_params.append(provider_key)
    if assignee:
        extra_clauses.append("i.assignee = ?")
        extra_params.append(assignee)
    extras_sql = ""
    if extra_clauses:
        extras_sql = " AND " + " AND ".join(extra_clauses)
    need_join = bool(extra_clauses)

    fts_query = _build_fts_query(stripped)
    if fts_query:
        try:
            if need_join:
                rows = conn.execute(
                    f"""
                    SELECT f.item_id
                    FROM items_fts f
                    JOIN items i ON i.id = f.item_id
                    WHERE items_fts MATCH ?{extras_sql}
                    ORDER BY rank
                    """,
                    [fts_query, *extra_params],
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT item_id FROM items_fts WHERE items_fts MATCH ? ORDER BY rank",
                    (fts_query,),
                ).fetchall()
            return _decode_ids(rows)
        except sqlite3.OperationalError:
            # FTS5 can reject things its tokenizer doesn't like; fall through
            # to the LIKE branch rather than hiding the result set entirely.
            pass
    like = f"%{stripped}%"
    if need_join:
        rows = conn.execute(
            f"""
            SELECT DISTINCT f.item_id
            FROM items_fts f
            JOIN items i ON i.id = f.item_id
            WHERE (f.title LIKE ? OR f.description_md LIKE ? OR f.comments_concat LIKE ?){extras_sql}
            """,
            [like, like, like, *extra_params],
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT DISTINCT item_id
            FROM items_fts
            WHERE title LIKE ? OR description_md LIKE ? OR comments_concat LIKE ?
            """,
            (like, like, like),
        ).fetchall()
    return _decode_ids(rows)


def search_similar(
    conn: sqlite3.Connection, title: str, *, provider_key: str | None = None
) -> list[str]:
    """Return item ids whose indexed content matches *any* word in `title`.

    Use this for duplicate detection during create — the AND semantics of
    `search()` are too strict ("Login redesign" AND'd won't hit an existing
    "Login" item). OR semantics catch near-matches the agent or user should
    reconsider. bm25 still ranks tight matches higher so candidates surface
    in a sensible order."""
    stripped = title.strip()
    if not stripped:
        return []
    terms = _terms(stripped)
    if not terms:
        return []
    # FTS5 OR: `a* OR b* OR c*`
    fts_query = " OR ".join(terms)
    try:
        if provider_key:
            rows = conn.execute(
                """
                SELECT f.item_id
                FROM items_fts f
                JOIN items i ON i.id = f.item_id
                WHERE items_fts MATCH ? AND i.provider_key = ?
                ORDER BY rank
                """,
                (fts_query, provider_key),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT item_id FROM items_fts WHERE items_fts MATCH ? ORDER BY rank",
                (fts_query,),
            ).fetchall()
    except sqlite3.OperationalError:
        return []
    return _decode_ids(rows)
