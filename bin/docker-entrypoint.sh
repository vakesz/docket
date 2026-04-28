#!/bin/sh
# Docker container entrypoint. Auto-generates boot secrets on first run if
# the operator didn't pre-set them, applies the schema, runs the bootstrap
# seed (idempotent — fills any rows DEV_* envs cover), then execs CMD.
#
# Boot secrets (`AUTH_SECRET`, `SECRETS_KEY`) live in
# `/app/data/secrets.env` if generated here. The path is mounted as the
# `docket-secrets` named volume in docker-compose so they survive
# `docker compose down` (only `down -v` wipes them). Operator-supplied
# env values always win.
set -e

SECRETS_DIR=/app/data
SECRETS_FILE="$SECRETS_DIR/secrets.env"

generate_b64_32() {
  # Try openssl first (smallest dep), fall back to /dev/urandom for distros
  # that don't ship it. Either way, 32 bytes of randomness, base64-encoded.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32
  else
    head -c 32 /dev/urandom | base64
  fi
}

ensure_secret() {
  name=$1
  eval "current=\${$name}"
  if [ -n "$current" ]; then
    return
  fi
  if [ ! -f "$SECRETS_FILE" ]; then
    mkdir -p "$SECRETS_DIR"
    : > "$SECRETS_FILE"
    chmod 600 "$SECRETS_FILE"
  fi
  # If the file already has the var, source it; else generate and append.
  existing=$(grep -E "^${name}=" "$SECRETS_FILE" | tail -n1 | cut -d'=' -f2- || true)
  if [ -n "$existing" ]; then
    eval "export $name=$existing"
    return
  fi
  value=$(generate_b64_32)
  printf '%s=%s\n' "$name" "$value" >> "$SECRETS_FILE"
  eval "export $name=$value"
  echo "[entrypoint] Generated $name into $SECRETS_FILE (first boot)."
}

require_env() {
  name=$1
  hint=$2
  eval "value=\${$name}"
  if [ -z "$value" ]; then
    echo "[entrypoint] FATAL: $name is not set. $hint" >&2
    exit 1
  fi
}

ensure_secret AUTH_SECRET
ensure_secret SECRETS_KEY

# AUTH_TRUST_HOST is also baked into the Dockerfile, but a stale image
# could be missing it — set it here defensively. Operator override wins.
if [ -z "${AUTH_TRUST_HOST:-}" ]; then
  export AUTH_TRUST_HOST=true
fi

require_env DATABASE_URL "Postgres connection string, e.g. postgresql://docket:docket@db:5432/docket?schema=public"
require_env PUBLIC_BASE_URL "Canonical URL the app is reached at, e.g. https://docket.example.com (no trailing slash)."

# TODO: switch to `bunx prisma migrate deploy` before the first deployment
# that holds real user data. Reasons:
#   - `db push --accept-data-loss` will silently drop columns/tables when
#     the local schema diverges from the live DB. Fine for solo dev (no
#     real data yet), unsafe once any tenant has data we can't lose.
#   - `migrate deploy` runs versioned, checked-in SQL files in order and
#     records them in `_prisma_migrations` — auditable history, idempotent
#     re-runs across container boots, hand-editable for renames / backfills
#     / partial uniques that `db push` can't express.
# Migration: run `bunx prisma migrate dev --name init` once on a clean dev
# DB to create the baseline, commit `prisma/migrations/`, then flip the
# command below to `bunx prisma migrate deploy`.
echo "[entrypoint] Applying database schema (prisma db push)..."
bunx prisma db push --accept-data-loss

# Raw-SQL post-push: pg_trgm extension, partial uniques on Setting, GIN
# trgm indexes on Item. Idempotent. Runs before the seed so any code path
# the seed exercises sees the final index set.
echo "[entrypoint] Applying raw-SQL indexes (idempotent)..."
bun run bin/apply-raw-sql.js || echo "[entrypoint] apply-raw-sql exited non-zero; continuing."

# Bootstrap seed: writes the initial LlmProvider + OauthProviderConfig rows
# from BOOTSTRAP/DEV_* env vars. Idempotent — once a row of a given kind
# exists, the seed leaves it alone, so the wizard's writes and env-driven
# writes coexist.
echo "[entrypoint] Running bootstrap seed (idempotent)..."
bun run bin/seed-dev.js || echo "[entrypoint] Seed exited non-zero; continuing."

echo "[entrypoint] Starting: $*"
exec "$@"
