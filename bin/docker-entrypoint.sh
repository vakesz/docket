#!/bin/sh
# Docker container entrypoint. Validates required env, applies the schema,
# runs the bootstrap seed (no-op once setup.complete flips), then execs the
# command from CMD.
set -e

require_env() {
  name=$1
  hint=$2
  eval "value=\${$name}"
  if [ -z "$value" ]; then
    echo "[entrypoint] FATAL: $name is not set. $hint" >&2
    exit 1
  fi
}

require_env DATABASE_URL "Postgres connection string, e.g. postgresql://docket:docket@db:5432/docket?schema=public"
require_env AUTH_SECRET "Random 32+ bytes for NextAuth session cookies. Generate via bin/generate-secrets.sh."
require_env SECRETS_KEY "32-byte base64 key for AES-GCM encryption of provider secrets. Generate via bin/generate-secrets.sh."
require_env PUBLIC_BASE_URL "Canonical URL the app is reached at, e.g. https://docket.example.com (no trailing slash)."

echo "[entrypoint] Applying database schema (prisma db push)..."
bunx prisma db push --accept-data-loss

# Bootstrap seed: writes the initial LlmProvider + OauthProviderConfig rows
# from BOOTSTRAP/DEV_* env vars. Idempotent and gated on setup.complete, so
# safe to run on every boot — once the operator has configured providers via
# the admin UI, this becomes a no-op.
echo "[entrypoint] Running bootstrap seed (idempotent)..."
bun run bin/seed-dev.js || echo "[entrypoint] Seed exited non-zero; continuing."

echo "[entrypoint] Starting: $*"
exec "$@"
