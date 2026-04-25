"""FastAPI factory.

The app is a pure adapter: it takes an already-wired SQLite connection,
provider, optional LLM client, and a shared proposal store, and exposes them
over HTTP. Production callers build the dependencies in `docket serve`; tests
build them with fakes."""

from __future__ import annotations

import sqlite3
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from docket.agent.llm_client import LlmClient
from docket.agent.mcp import MCPManager
from docket.api.agent_rebuild import rebuild_agent
from docket.api.auth import require_bearer
from docket.api.routes import conversations as conversations_routes
from docket.api.routes import items as items_routes
from docket.api.routes import mcp as mcp_routes
from docket.api.routes import memory as memory_routes
from docket.api.routes import mutations as mutations_routes
from docket.api.routes import pins as pins_routes
from docket.api.routes import projects as projects_routes
from docket.api.routes import prompts as prompts_routes
from docket.api.routes import providers as providers_routes
from docket.api.routes import scopes as scopes_routes
from docket.api.routes import settings as settings_routes
from docket.api.routes import setup as setup_routes
from docket.api.routes import source as source_routes
from docket.api.routes import status as status_routes
from docket.api.routes import suggestions as suggestions_routes
from docket.api.routes import sync as sync_routes
from docket.api.runtime import RuntimeState
from docket.api.schemas import HealthDTO
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Tear down resources that outlive a single request.

    Currently just MCP subprocesses: their stdio sessions and child
    processes need an explicit `close_all()` so the OS reclaims them
    when the server exits cleanly. SQLite/provider lifetimes are owned
    by the caller (`docket serve`), not the FastAPI app."""
    try:
        yield
    finally:
        mgr = getattr(app.state, "mcp_manager", None)
        if mgr is not None:
            mgr.close_all()


def create_app(
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    bearer_token: str,
    llm: LlmClient | None = None,
    proposals: ProposalStore | None = None,
    active_item: Callable[[], str | None] | None = None,
    compaction_threshold_tokens: int = 0,
    read_only: bool = False,
    paths: Paths | None = None,
    runtime: RuntimeState | None = None,
    setup_token: str = "",
    config: Config | None = None,
) -> FastAPI:
    """Build a configured FastAPI app.

    `bearer_token` must be non-empty; an empty token would silently disable
    auth, which we refuse to do.

    `read_only=True` blocks every POST on the mutation surface (the router
    attaches `require_not_read_only` as a dependency) and skips registering
    mutating tools for the agent. Read endpoints keep working unchanged.

    `paths` and `runtime` are optional so lightweight test fixtures can
    spin up an app without wiring the whole runtime. When omitted, the
    endpoints that need them return 503; when set (by `docket serve`),
    pins/suggestions/prompts/settings/scopes/providers/sync/status work
    end-to-end.
    """
    if not bearer_token:
        raise ValueError(
            "HTTP surface requires a non-empty bearer token. "
            "Set config.http.token or disable the surface."
        )

    app = FastAPI(
        title="Docket",
        version="0.1.0",
        description="Terminal work-item triage over HTTP.",
        lifespan=_lifespan,
    )
    app.state.conn = conn
    app.state.provider = provider
    app.state.bearer_token = bearer_token
    app.state.proposals = proposals if proposals is not None else ProposalStore()
    app.state.llm = llm
    app.state.active_item = active_item
    app.state.compaction_threshold_tokens = compaction_threshold_tokens
    app.state.read_only = read_only
    app.state.paths = paths
    app.state.runtime = runtime
    app.state.setup_token = setup_token
    app.state.config = config if config is not None else (runtime.config if runtime else None)

    # Wire MCP into the runtime so scope/provider switches rebind the
    # fleet to the new project. Skip in read-only mode — `build_agent`
    # would strip the tools anyway, and we'd rather not spawn
    # subprocesses we'll never call. The manager is mounted on
    # `app.state.mcp_manager` for shutdown handlers and tests.
    mcp_manager: MCPManager | None = None
    if runtime is not None and not read_only:
        mcp_manager = MCPManager()
        runtime.mcp_manager = mcp_manager
        project = runtime.config.projects.get(runtime.project_id)
        servers = dict(project.mcp) if project is not None else {}
        mcp_manager.bind_project(runtime.project_id, servers)
    app.state.mcp_manager = mcp_manager

    rebuild_agent(app, runtime)

    # Sub-routers keyed off `/items/{item_id:path}/…` must be registered
    # before the catch-all item routes, otherwise the `:path` converter
    # on the plain `/{item_id}` route greedy-matches and swallows
    # `/conversation`, `/pinned`, etc. into the item id.
    app.include_router(mutations_routes.router)
    app.include_router(conversations_routes.router)
    app.include_router(pins_routes.router)
    app.include_router(suggestions_routes.router)
    app.include_router(items_routes.router)
    app.include_router(prompts_routes.router)
    app.include_router(settings_routes.router)
    app.include_router(scopes_routes.router)
    app.include_router(providers_routes.router)
    # Memory routes must come before `projects_routes` because the catch-all
    # `/projects/{project_id:path}` greedy-matches and would swallow
    # `/projects/{project_id}/memory` into the project_id. Same applies to
    # source and mcp routes.
    app.include_router(memory_routes.router)
    app.include_router(source_routes.router)
    app.include_router(mcp_routes.router)
    app.include_router(projects_routes.router)
    app.include_router(sync_routes.router)
    app.include_router(status_routes.router)
    app.include_router(setup_routes.router)

    @app.get("/health", response_model=HealthDTO, tags=["health"])
    def health() -> HealthDTO:
        return HealthDTO()

    @app.get("/whoami", tags=["health"], dependencies=[Depends(require_bearer)])
    def whoami() -> dict[str, str]:
        return {"app": "docket", "status": "ok"}

    return app


__all__ = ["create_app"]
