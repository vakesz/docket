# syntax=docker/dockerfile:1.7
#
# Self-host image for Docket. Three stages:
#
#   deps     — install all node_modules (incl. dev deps; needed for prisma generate
#              and next build). Cached on package.json + bun.lock.
#   builder  — generate the Prisma client into ./src/db/generated and run `next build`.
#   runner   — copy only the artifacts the runtime needs (node_modules, .next,
#              prisma schema, generated client, bin scripts) and run `next start` via bun.
#
# We deliberately do NOT use Next's `output: standalone` mode here — Prisma 7
# with a custom client output directory + Bun runtime hits enough tracing
# edge cases that the marginal image-size win isn't worth the moving parts.
# Revisit if image size becomes a real cost.

ARG BUN_VERSION=1.3.13

# ---------------------------------------------------------------------------
# deps — install dependencies
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — prisma generate + next build
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json next.config.ts postcss.config.mjs biome.json components.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY src ./src
COPY bin ./bin

# Defense-in-depth against a stale .dockerignore: scrub any locally-built
# artifact that may have slipped into the build context before we generate
# our own. If these existed in the context, they shouldn't influence the
# image we ship.
RUN rm -rf .next out .turbo .vercel build dist src/db/generated bin/seed-dev.js \
    && find . -name '*.tsbuildinfo' -delete

RUN bunx prisma generate
RUN bun run build
# Bundle the bootstrap seed into a single self-contained JS file so the
# runtime image doesn't need the TS source tree. `--conditions react-server`
# resolves the `server-only` marker package to its no-op shim instead of the
# throw-on-import default.
RUN bun build bin/seed-dev.ts --target=bun --conditions react-server --outfile bin/seed-dev.js

# ---------------------------------------------------------------------------
# runner — minimal runtime image
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Auth.js v5 refuses non-Vercel hosts in production unless this is set.
# Self-host always wants it on; operators can override via env if needed.
ENV AUTH_TRUST_HOST=true

# openssl is used by the entrypoint to generate AUTH_SECRET / SECRETS_KEY
# on first boot when the operator hasn't pre-set them. ~1.5 MB.
RUN apk add --no-cache openssl

# Non-root user
RUN addgroup -S -g 1001 docket && adduser -S -G docket -u 1001 docket

# Persisted-state directory for auto-generated boot secrets. The entrypoint
# writes /app/data/secrets.env on first boot if AUTH_SECRET / SECRETS_KEY
# are not set; docker-compose mounts the docket-secrets volume here so
# they survive container removal.
RUN mkdir -p /app/data && chown -R docket:docket /app/data

COPY --from=builder --chown=docket:docket /app/node_modules ./node_modules
COPY --from=builder --chown=docket:docket /app/.next ./.next
COPY --from=builder --chown=docket:docket /app/prisma ./prisma
COPY --from=builder --chown=docket:docket /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=docket:docket /app/src/db/generated ./src/db/generated
COPY --from=builder --chown=docket:docket /app/bin ./bin
COPY --from=builder --chown=docket:docket /app/package.json ./package.json

RUN chmod +x ./bin/docker-entrypoint.sh
USER docket
EXPOSE 3000

ENTRYPOINT ["./bin/docker-entrypoint.sh"]
CMD ["bun", "run", "start"]
