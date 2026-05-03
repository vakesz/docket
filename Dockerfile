# syntax=docker/dockerfile:1.7
#
# Self-host image for Docket. Four stages:
#
#   deps      — install all node_modules (incl. dev deps; needed for next
#               build and the bundle step). Cached on package.json + pnpm-lock.yaml.
#   builder   — run `next build` and esbuild-bundle the seed/migrate scripts.
#   prod-deps — install production-only node_modules from the same lockfile.
#               This is what the runner ships, so devDependencies (esbuild,
#               biome, vitest, tsx, drizzle-kit, @types/*, …) never make it
#               into the runtime image.
#   runner    — copy only the artifacts the runtime needs (prod node_modules,
#               .next, drizzle migrations, bundled bin scripts) and run
#               `next start`.
#
# We deliberately do NOT use Next's `output: standalone` mode here — file
# tracing has historically had edge cases on this app. The marginal image-size
# win isn't worth the moving parts. Revisit if image size becomes a real cost.
#
# pnpm exists only at build time. The runner stage launches Next directly
# via the bundled binary so the runtime image stays free of pnpm + corepack.

# Pinned to a full patch so the image is bit-for-bit reproducible.
# Dependabot's `docker` ecosystem (.github/dependabot.yml) tracks this ARG
# default and will open PRs when a new patch lands. Must satisfy the strictest
# transitive engines.node constraint in pnpm-lock.yaml, which `engine-strict=true`
# in .npmrc enforces at install.
ARG NODE_VERSION=22.22.2
ARG PNPM_VERSION=9.15.4

# ---------------------------------------------------------------------------
# deps — install all dependencies (dev + prod) for the build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — next build + bundle bin scripts
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml .npmrc tsconfig.json next.config.ts postcss.config.mjs ./
COPY drizzle.config.ts ./drizzle.config.ts
COPY drizzle ./drizzle
COPY src ./src
COPY bin ./bin

# Defense-in-depth against a stale .dockerignore: scrub any locally-built
# artifact that may have slipped into the build context before we generate
# our own. If these existed in the context, they shouldn't influence the
# image we ship.
RUN rm -rf .next out .turbo .vercel build dist bin/bootstrap-providers.mjs bin/db-migrate.mjs \
    && find . -name '*.tsbuildinfo' -delete

RUN pnpm run build
# Bundle the provider bootstrap and the migration runner into single
# self-contained ESM files so the runtime image doesn't need the TS source
# tree. `--conditions=react-server` resolves the `server-only` marker package
# to its no-op shim instead of the throw-on-import default. The
# `createRequire` banner lets any CJS deps inside the bundle keep using
# `require()` from an ESM context.
RUN pnpm exec esbuild bin/bootstrap-providers.ts --bundle --platform=node --target=node22 --format=esm --conditions=react-server --outfile=bin/bootstrap-providers.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
RUN pnpm exec esbuild bin/db-migrate.ts --bundle --platform=node --target=node22 --format=esm --conditions=react-server --outfile=bin/db-migrate.mjs --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'

# ---------------------------------------------------------------------------
# prod-deps — production-only node_modules for the runtime image
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app

ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod

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

# Production-only node_modules (no devDependencies). Sourced from the
# dedicated prod-deps stage so esbuild/biome/vitest/tsx/drizzle-kit never
# reach the runtime image.
COPY --from=prod-deps --chown=docket:docket /app/node_modules ./node_modules
COPY --from=builder --chown=docket:docket /app/.next ./.next
COPY --from=builder --chown=docket:docket /app/drizzle ./drizzle
# Only the runtime files — the .ts sources are bundled into the .mjs files
# in the builder stage and not needed at runtime.
COPY --from=builder --chown=docket:docket /app/bin/docker-entrypoint.sh ./bin/docker-entrypoint.sh
COPY --from=builder --chown=docket:docket /app/bin/bootstrap-providers.mjs ./bin/bootstrap-providers.mjs
COPY --from=builder --chown=docket:docket /app/bin/db-migrate.mjs ./bin/db-migrate.mjs
COPY --from=builder --chown=docket:docket /app/package.json ./package.json

RUN chmod +x ./bin/docker-entrypoint.sh
USER docket
EXPOSE 3000

# Liveness probe hits the public tRPC `health.ping` query (no auth required).
# wget ships with busybox in node-alpine; --spider returns non-zero on a
# non-2xx response, which is what HEALTHCHECK wants.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${PORT}/api/trpc/health.ping" || exit 1

ENTRYPOINT ["./bin/docker-entrypoint.sh"]
CMD ["node", "node_modules/next/dist/bin/next", "start"]
