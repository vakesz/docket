# Storage Cache

- SQLite is a cache and transcript store, not the work-item source of truth.
- Always initialize DB handles through `init_db(...)` so application-id checks and schema-reset logic run.
- Prefer repository helpers for row-shape logic and bulk upserts.
- Watchlist semantics intentionally outlive the current cached scope.
- Search behavior is FTS-backed and tuned for prefix matching, not arbitrary SQL `LIKE` everywhere.
- Related docs: [Architecture](../architecture.md), [Mutation Pipeline](mutation-pipeline.md), [TUI Surface](tui-surface.md)

## Architecture Overview

```text
provider.list_changes_since(...)
          |
          v
sync_service.refresh(...)
          |
          v
item_repo.upsert_items(...) + sync_repo.set_watermark(...)
          |
          +--> items / comments / messages / watchlist / sync_state
          +--> items_fts for search
```

## Ownership Boundaries

- `src/docket/storage/db.py` owns connection settings, schema-version checks, and transactional helpers.
- `src/docket/storage/schema.py` owns the current cache schema shape.
- `src/docket/storage/repos/` own row mapping and query behavior.
- `src/docket/core/services/` decide when to sync, compact, or refresh cached data.

## Core Rules

- Open SQLite with `init_db(...)`, not raw `sqlite3.connect(...)`, so application-id validation and schema-reset logic happen (`src/docket/storage/db.py`).
- Keep connection usage explicit; contexts and app state should carry the handle through (`src/docket/cli/context.py`, `src/docket/api/app.py`).
- Use bulk upserts for sync paths (`src/docket/core/services/sync_service.py`, `src/docket/storage/repos/item_repo.py`).
- Preserve FTS query-building semantics in `search_repo.py`; it intentionally tokenizes on word runs and uses prefix AND or duplicate-detection OR behavior.
- Preserve the no-FK watchlist design so pins can survive scope changes (`src/docket/storage/schema.py`, `src/docket/storage/repos/watchlist_repo.py`).

## Code Pattern

```python
with transaction(conn):
    upserted = item_repo.upsert_items(conn, items)
    archived = item_repo.mark_archived(conn, archived_ids)
    new_watermark = max_seen or datetime.now(UTC)
    sync_repo.set_watermark(conn, scope_key, new_watermark)
```

Derived from `src/docket/core/services/sync_service.py`.

## Non-Obvious Patterns

- `check_same_thread=False` is intentional because worker threads interact with the same connection.
- The SQLite `application_id` guard protects against opening an unrelated `.db` file as a Docket cache.
- Search falls back from FTS to `LIKE` on tokenizer or syntax failures so UI searches still return best-effort results.

## Validation Checklist

- [ ] `uv run pytest tests/integration/test_repos.py tests/integration/test_search_repo.py tests/integration/test_db_reset.py`
- [ ] `uv run pytest tests/test_sync_service.py tests/test_watchlist_repo.py tests/test_sync_perf.py`
- [ ] If you touched transcript or conversation tables, also run `uv run pytest tests/test_conversation_service.py tests/test_compaction.py`
