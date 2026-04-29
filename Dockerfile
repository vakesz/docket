# syntax=docker/dockerfile:1.7
#
# Self-host image for Docket. Three stages:
#
#   deps     — install all node_modules (incl. dev deps; needed for prisma generate
#              and next build). Cached on package.json + pnpm-lock.yaml.
#   builder  — generate the Prisma client into ./src/db/generated and run `next build`.
#   runner   — copy only the artifacts the runtime needs (node_modules, .next,
#              prisma schema, generated client, bin scripts) and run `next start`.
#
# We deliberately do NOT use Next's `output: standalone` mode here — Prisma 7
# with a custom client output directory hits enough tracing edge cases that
# the marginal image-size win isn't worth the moving parts. Revisit if image
# size becomes a real cost.
#
# pnpm exists only at build time. The runner stage launches Next directly
# via the bundled binary so the runtime image stays free of pnpm + corepack.

ARG NODE_VERSION=22.11

# ---------------------------------------------------------------------------
# deps — install dependencies
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — prisma generate + next build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc tsconfig.json next.config.ts postcss.config.mjs biome.json components.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./prisma.config.ts
COPY src ./src
COPY bin ./bin

# Defense-in-depth against a stale .dockerignore: scrub any locally-built
# artifact that may have slipped into the build context before we generate
# our own. If these existed in the context, they shouldn't influence the
# image we ship.
RUN rm -rf .next out .turbo .vercel build dist src/db/generated bin/seed-dev.mjs bin/apply-raw-sql.mjs \
    && find . -name '*.tsbuildinfo' -delete

RUN pnpm exec prisma generate
RUN pnpm run build
# Bundle the bootstrap seed and the post-`prisma db push` raw-SQL script
# into single self-contained ESM files so the runtime image doesn't need the
# TS source tree. `--conditions=react-server` resolves the `server-only`
# marker package to its no-op shim instead of the throw-on-import default.
# The `createRequire` banner lets any CJS deps inside the bundle keep using
# `require()` from an ESM context (Prisma's runtime relies on this).
RUN pnpm exec esbuild bin/seed-dev.ts --bundle --platform=node --target=node22 --format=esm --conditions=react-server --outfile=bin/seed-dev.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
RUN pnpm exec esbuild bin/apply-raw-sql.ts --bundle --platform=node --target=node22 --format=esm --conditions=react-server --outfile=bin/apply-raw-sql.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

# ---------------------------------------------------------------------------
# runner — minimal runtime image
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runner
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
CMD ["node", "node_modules/next/dist/bin/next", "start"]
