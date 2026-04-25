"""FastAPI dependency accessors.

The API is a thin adapter: connection, provider, LLM, proposal store, and the
(optional) agent loop all live on `app.state`, assembled in `create_app`. These
helpers give route handlers typed access without importing `app` back into
themselves.

Each public dep is its own named function so FastAPI's per-request
dependency cache (keyed on callable identity) keeps them deduplicated across
routes."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from typing import cast

from fastapi import HTTPException, Request, status
from pydantic import BaseModel

from docket.agent.llm_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.api.runtime import RuntimeState
from docket.config.models import Config, ProjectEntry
from docket.config.paths import Paths
from docket.core.mutation import Proposal
from docket.core.services.proposal_store import PendingProposal, ProposalStore
from docket.core.services.question_store import QuestionStore
from docket.providers.base import WorkItemProvider


def _require[T](
    request: Request,
    attr: str,
    tp: type[T],
    *,
    detail: str,
    status_code: int = status.HTTP_503_SERVICE_UNAVAILABLE,
) -> T:
    """Return `request.app.state.<attr>` or raise with the given detail.

    `tp` exists to bind the return type — there is no runtime isinstance
    check because Protocol types (LlmClient, WorkItemProvider) can't be
    narrowed that way and the wiring layer is the only writer."""
    value = getattr(request.app.state, attr, None)
    if value is None:
        raise HTTPException(status_code=status_code, detail=detail)
    return cast(T, value)


def get_conn(request: Request) -> sqlite3.Connection:
    return _require(
        request,
        "conn",
        sqlite3.Connection,
        detail="SQLite connection is not wired into the app.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )


def get_provider(request: Request) -> WorkItemProvider:
    runtime: RuntimeState | None = getattr(request.app.state, "runtime", None)
    if runtime is not None:
        return runtime.provider
    provider = getattr(request.app.state, "provider", None)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Provider is not wired into the app.",
        )
    return cast(WorkItemProvider, provider)


def get_proposals(request: Request) -> ProposalStore:
    return _require(
        request,
        "proposals",
        ProposalStore,
        detail="Proposal store is not wired into the app.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )


def get_questions(request: Request) -> QuestionStore:
    return _require(
        request,
        "questions",
        QuestionStore,
        detail="Question store is not wired into the app.",
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
    )


def require_agent(request: Request) -> AgentLoop:
    return _require(
        request,
        "agent",
        AgentLoop,
        detail="Chat is disabled — no LLM client was configured for this server.",
    )


def require_llm(request: Request) -> LlmClient:
    llm = getattr(request.app.state, "llm", None)
    if llm is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="LLM is not configured — feature unavailable on this server.",
        )
    return cast(LlmClient, llm)


def require_not_read_only(request: Request) -> None:
    if getattr(request.app.state, "read_only", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Read-only mode — mutations disabled.",
        )


def get_paths(request: Request) -> Paths:
    return _require(
        request,
        "paths",
        Paths,
        detail="Paths are not wired — this endpoint requires `docket serve`.",
    )


def get_runtime(request: Request) -> RuntimeState:
    return _require(
        request,
        "runtime",
        RuntimeState,
        detail="Runtime state is not wired — this endpoint requires `docket serve`.",
    )


def get_runtime_optional(request: Request) -> RuntimeState | None:
    return getattr(request.app.state, "runtime", None)


def get_active_provider_key(request: Request) -> str:
    """Active provider key from the runtime, or `""` when no runtime is wired
    (e.g., bootstrap mode or tests). Repos truth-test this value, so `""` and
    `None` are handled identically downstream."""
    runtime: RuntimeState | None = getattr(request.app.state, "runtime", None)
    return runtime.provider_key if runtime is not None else ""


def require_project(config: Config, project_id: str) -> ProjectEntry:
    """Return the registered project entry or raise HTTP 404.

    Most callers use this purely as a guard and ignore the return; the
    return value is there so endpoints that also need the entry don't have
    to look it up a second time."""
    entry = config.projects.get(project_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")
    return entry


def get_config(request: Request) -> Config:
    """Return the in-memory `Config` object the server was booted with.

    Mutations that need to persist back to disk should also use `get_paths()`
    so they can call `save_config(paths, config)`."""
    return _require(
        request,
        "config",
        Config,
        detail="Config is not wired — this endpoint requires `docket serve`.",
    )


def require_by_id[T](
    fetcher: Callable[[sqlite3.Connection, str], T | None],
    conn: sqlite3.Connection,
    entity_id: str,
    *,
    label: str,
) -> T:
    """Fetch an entity by id via `fetcher(conn, id)` or raise HTTP 404.

    `label` is interpolated into the 404 message — e.g. `label="memory entry"`
    becomes `"Unknown memory entry 'mem-123'"`."""
    entry = fetcher(conn, entity_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown {label} '{entity_id}'")
    return entry


def require_pending_proposal(
    store: ProposalStore,
    proposal_id: str,
    *,
    consume: bool = False,
    expected: type[Proposal] | None = None,
) -> PendingProposal:
    """Look up a pending proposal or raise HTTP 404.

    `consume=True` removes it from the store (confirm/reject); the default
    just peeks (get). `expected` enforces an isinstance gate so the
    `ItemCreate` proposals route doesn't accidentally consume a per-item
    mutation proposal that happens to share an id namespace."""
    pending = store.pop(proposal_id) if consume else store.get(proposal_id)
    if pending is None or (expected is not None and not isinstance(pending.proposal, expected)):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown proposal '{proposal_id}'")
    return pending


def require_patch_not_empty(payload: BaseModel, *, label: str) -> None:
    """Raise HTTP 400 if every field on a PATCH payload is None.

    PATCH endpoints accept all-optional models so a partial update can be
    expressed with one or two fields, but submitting an empty patch is
    almost always a bug — better to surface it than silently no-op."""
    if all(v is None for v in payload.model_dump().values()):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"At least one {label} field must be set.",
        )


__all__ = [
    "get_active_provider_key",
    "get_config",
    "get_conn",
    "get_paths",
    "get_proposals",
    "get_provider",
    "get_questions",
    "get_runtime",
    "get_runtime_optional",
    "require_agent",
    "require_by_id",
    "require_llm",
    "require_not_read_only",
    "require_patch_not_empty",
    "require_pending_proposal",
    "require_project",
]
