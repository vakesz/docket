"""FastAPI dependency accessors.

The API is a thin adapter: connection, provider, LLM, proposal store, and the
(optional) agent loop all live on `app.state`, assembled in `create_app`. These
helpers give route handlers typed access without importing `app` back into
themselves."""

from __future__ import annotations

import sqlite3

from fastapi import HTTPException, Request, status

from docket.agent.llm_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.api.runtime import RuntimeState
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider


def get_conn(request: Request) -> sqlite3.Connection:
    conn: sqlite3.Connection | None = getattr(request.app.state, "conn", None)
    if conn is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="SQLite connection is not wired into the app.",
        )
    return conn


def get_provider(request: Request) -> WorkItemProvider:
    runtime: RuntimeState | None = getattr(request.app.state, "runtime", None)
    if runtime is not None:
        return runtime.provider
    provider: WorkItemProvider | None = getattr(request.app.state, "provider", None)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Provider is not wired into the app.",
        )
    return provider


def get_proposals(request: Request) -> ProposalStore:
    store: ProposalStore | None = getattr(request.app.state, "proposals", None)
    if store is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Proposal store is not wired into the app.",
        )
    return store


def require_agent(request: Request) -> AgentLoop:
    agent: AgentLoop | None = getattr(request.app.state, "agent", None)
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Chat is disabled — no LLM client was configured for this server.",
        )
    return agent


def require_llm(request: Request) -> LlmClient:
    llm: LlmClient | None = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM is not configured — feature unavailable on this server.",
        )
    return llm


def require_not_read_only(request: Request) -> None:
    if getattr(request.app.state, "read_only", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only mode — mutations disabled.",
        )


def get_paths(request: Request) -> Paths:
    paths: Paths | None = getattr(request.app.state, "paths", None)
    if paths is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Paths are not wired — this endpoint requires `docket serve`.",
        )
    return paths


def get_runtime(request: Request) -> RuntimeState:
    runtime: RuntimeState | None = getattr(request.app.state, "runtime", None)
    if runtime is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Runtime state is not wired — this endpoint requires `docket serve`.",
        )
    return runtime


def get_runtime_optional(request: Request) -> RuntimeState | None:
    return getattr(request.app.state, "runtime", None)


def get_active_provider_key(request: Request) -> str:
    """Active provider key from the runtime, or `""` when no runtime is wired
    (e.g., bootstrap mode or tests). Repos truth-test this value, so `""` and
    `None` are handled identically downstream."""
    runtime: RuntimeState | None = getattr(request.app.state, "runtime", None)
    return runtime.provider_key if runtime is not None else ""


def require_project(config: Config, project_id: str) -> None:
    """Raise HTTP 404 if `project_id` is not registered in the active config."""
    if project_id not in config.projects:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")


def get_config(request: Request) -> Config:
    """Return the in-memory `Config` object the server was booted with.

    Mutations that need to persist back to disk should also use `get_paths()`
    so they can call `save_config(paths, config)`."""
    cfg: Config | None = getattr(request.app.state, "config", None)
    if cfg is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Config is not wired — this endpoint requires `docket serve`.",
        )
    return cfg


__all__ = [
    "get_active_provider_key",
    "get_config",
    "get_conn",
    "get_paths",
    "get_proposals",
    "get_provider",
    "get_runtime",
    "get_runtime_optional",
    "require_agent",
    "require_llm",
    "require_not_read_only",
    "require_project",
]
