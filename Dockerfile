# syntax=docker/dockerfile:1.7
### Docket backend — FastAPI image (uvicorn + uv-managed venv)
#
# Built with `uv` for fast, deterministic installs. The `gh` and `az` CLIs
# are installed because two providers (github, azure_devops) shell out to
# them for auth/discovery. If you don't use those providers you can strip
# the CLI stage.

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app

# Install locked deps first with only manifests mounted in — this layer
# is reused across rebuilds whenever src/ changes but pyproject/uv.lock don't.
# `--mount=type=cache` keeps uv's wheel cache between builds.
RUN --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=README.md,target=README.md \
    --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY pyproject.toml uv.lock README.md ./
COPY src ./src

RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --python /opt/venv/bin/python .


FROM python:3.12-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:${PATH}" \
    XDG_CONFIG_HOME=/data/config \
    XDG_STATE_HOME=/data/state \
    XDG_CACHE_HOME=/data/cache

# Keep apt archives across builds (overrides the Debian image's docker-clean).
RUN rm -f /etc/apt/apt.conf.d/docker-clean && \
    echo 'Binary::apt::APT::Keep-Downloaded-Packages "true";' > /etc/apt/apt.conf.d/keep-cache

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git tini && \
    mkdir -p -m 0755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
      tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null && \
    chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    curl -sL https://packages.microsoft.com/keys/microsoft.asc | \
      gpg --dearmor -o /etc/apt/keyrings/microsoft.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/azure-cli/ bookworm main" \
      > /etc/apt/sources.list.d/azure-cli.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh azure-cli

COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src

RUN mkdir -p /data/config/docket /data/state/docket /data/cache/docket

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8765/health || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["docket", "serve", "--host", "0.0.0.0", "--port", "8765"]
