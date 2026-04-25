"""Helper for repos that build `UPDATE ... SET` clauses from optional patch fields.

Three repos (memory, source, project) implement the same shape:

    fields, params = [], []
    if title is not None:
        fields.append("title = ?"); params.append(clean_title(title))
    if body_md is not None:
        fields.append("body_md = ?"); params.append(body_md)
    ...
    if not fields: return existing
    fields.append("updated_at = ?"); params.append(now_iso())

`build_set_clause` keeps the per-field None checks and value transforms in the
caller (where they belong — every column has its own normalization), but
removes the parallel-list ceremony and the manual `updated_at` tail."""

from __future__ import annotations

from docket.storage._time import now_iso


def build_set_clause(
    fields: list[tuple[str, object]],
    *,
    touch_updated_at: bool = True,
) -> tuple[str, list[object]] | None:
    """Build `col = ?, col = ?, ...` from explicit (column, value) pairs.

    Returns (sql_fragment, params) or None when `fields` is empty so the
    caller can short-circuit and return the unchanged row. With
    `touch_updated_at=True`, appends `updated_at = ?` with the current ISO
    timestamp; pass `False` for tables without that column (e.g. projects).

    Callers transform values (clean_title, json.dumps, …) BEFORE passing
    them in — the helper does no normalization."""
    if not fields:
        return None
    cols = [f"{name} = ?" for name, _ in fields]
    params: list[object] = [val for _, val in fields]
    if touch_updated_at:
        cols.append("updated_at = ?")
        params.append(now_iso())
    return ", ".join(cols), params


__all__ = ["build_set_clause"]
