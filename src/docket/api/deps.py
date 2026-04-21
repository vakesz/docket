"""FastAPI dependency accessors.

The API is a thin adapter: connection, provider, LLM, proposal store, and the
(optional) agent loop all live on `app.state`, assembled in `create_app`. These
helpers give route handlers typed access without importing `app` back into
themselves."""
from __future__ import annotations

import sqlite3

from fastapi import HTTPException, Request, status

from docket.agent.loop import AgentLoop
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


def require_not_read_only(request: Request) -> None:
    if getattr(request.app.state, "read_only", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only mode — mutations disabled.",
        )


__all__ = [
    "get_conn",
    "get_proposals",
    "get_provider",
    "require_agent",
    "require_not_read_only",
]
