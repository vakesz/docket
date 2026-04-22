# syntax=docker/dockerfile:1.7
### Docket frontend — production image
#
# Stage 1 installs full dependencies and runs `bun run build`.
# Stage 2 installs production-only deps and copies the built bundle +
# `server.ts` (the Bun wrapper that proxies /api/* to the backend).
#
# Runtime port is PORT (default 3000); upstream is DOCKET_API_URL (default
# http://backend:8765 inside compose).

FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

COPY tsconfig.json vite.config.ts biome.json ./
COPY src ./src
RUN bun run build


FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY server.ts ./

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

CMD ["bun", "run", "server.ts"]
