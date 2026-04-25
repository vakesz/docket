"""Full-text search over the cache via SQLite FTS5 (schema v5).

`search(conn, query)` returns item ids ranked by bm25. User input is treated
as a set of prefix-matched terms. The `operator` controls how terms combine —
implicit AND for the type-as-you-filter UX in the TUI's left pane, OR for
duplicate-detection during item create where AND is too strict (e.g. "Login
redesign" AND'd won't surface an existing "Login" item).
"""

from __future__ import annotations

import re
import sqlite3
from typing import Literal

from docket.storage.item_keys import item_id_from_storage_key

_WORD = re.compile(r"\w+", flags=re.UNICODE)


def _terms(raw: str) -> list[str]:
    return [f"{m.group(0)}*" for m in _WORD.finditer(raw)]


def _build_fts_query(raw: str, *, operator: Literal["AND", "OR"]) -> str:
    """Turn free-text user input into a safe FTS5 MATCH expression.

    Extracts word runs (same shape the unicode61 tokenizer produces on the
    indexed side), appends `*` for prefix match, and joins with ` ` (implicit
    AND) or ` OR ` per `operator`. Returns an empty string if nothing
    survives. Splitting on non-word boundaries rather than whitespace means
    inputs like `AUTH-42` become two matchable terms (`AUTH*`, `42*`) that
    line up with how the content was tokenized."""
    terms = _terms(raw)
    if not terms:
        return ""
    sep = " OR " if operator == "OR" else " "
    return sep.join(terms)


def _decode_ids(rows: list[sqlite3.Row]) -> list[str]:
    return [item_id_from_storage_key(row[0]) for row in rows]


def search(
    conn: sqlite3.Connection,
    query: str,
    *,
    provider_key: str | None = None,
    assignee: str | None = None,
    operator: Literal["AND", "OR"] = "AND",
) -> list[str]:
    """Return item ids matching `query`, ranked best-first.

    `assignee` is a post-cache visual filter — resolved `@me` identity or
    any exact assignee string. `None`/empty means "no narrowing".
    `operator="OR"` is for duplicate detection during create; default AND
    matches the type-as-you-filter UX.

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

    fts_query = _build_fts_query(stripped, operator=operator)
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
