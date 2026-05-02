-- Hand-written migration: install the `pg_trgm` extension that backs the
-- GIN indexes in 0002_gin_trgm_indexes.sql. The Postgres 16 image ships
-- pg_trgm pre-compiled; this just registers it on the database. Idempotent
-- via IF NOT EXISTS — re-running the migrate step from any starting state
-- (fresh boot, partial install, or already-extended DB) is safe.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
