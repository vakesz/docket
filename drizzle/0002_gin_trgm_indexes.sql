-- Hand-written migration: GIN trigram indexes that back the ILIKE
-- substring searches on item title/description and memory entry
-- title/body. drizzle-kit can't model `gin_trgm_ops` operator classes, so
-- these live outside the schema and ride here as a versioned migration.
--
-- Future schema changes that touch `items.title` / `items.description` /
-- `memory_entries.title` / `memory_entries.body` must keep these in mind:
-- a column rename or type change requires a follow-up migration that
-- re-creates the index.
--
-- IF NOT EXISTS keeps re-runs idempotent.

CREATE INDEX IF NOT EXISTS items_title_trgm_idx
  ON items USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_description_trgm_idx
  ON items USING gin (description gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memory_entries_title_trgm_idx
  ON memory_entries USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS memory_entries_body_trgm_idx
  ON memory_entries USING gin (body gin_trgm_ops);
