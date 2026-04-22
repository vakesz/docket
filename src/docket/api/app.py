"""FastAPI factory.

The app is a pure adapter: it takes an already-wired SQLite connection,
provider, optional LLM client, and a shared proposal store, and exposes them
over HTTP. Production callers build the dependencies in `docket serve`; tests
build them with fakes."""
from __future__ import annotations

import sqlite3
from collections.abc import Callable

from fastapi import Depends, FastAPI

from docket.agent.foundry_client import LlmClient
from docket.agent.loop import AgentLoop
from docket.agent.mutating_tools import register_mutating_tools
from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.api.auth import require_bearer
from docket.api.routes import conversations as conversations_routes
from docket.api.routes import items as items_routes
from docket.api.routes import mutations as mutations_routes
from docket.api.routes import pins as pins_routes
from docket.api.routes import prompts as prompts_routes
from docket.api.routes import providers as providers_routes
from docket.api.routes import scopes as scopes_routes
from docket.api.routes import settings as settings_routes
from docket.api.routes import setup as setup_routes
from docket.api.routes import status as status_routes
from docket.api.routes import suggestions as suggestions_routes
from docket.api.routes import sync as sync_routes
from docket.api.runtime import RuntimeState
from docket.api.schemas import HealthDTO
from docket.config.paths import Paths
from docket.core.services.proposal_store import ProposalStore
from docket.providers.base import WorkItemProvider


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
) -> FastAPI:
    """Build a configured FastAPI app.

    `bearer_token` must be non-empty; an empty token would silently disable
    auth, which we refuse to do.

    `read_only=True` blocks every POST on the mutation surface (the router
    attaches `require_not_read_only` as a dependency) and skips registering
    mutating tools for the agent. Read endpoints keep working unchanged.

    `paths` and `runtime` are optional for backwards compatibility with the
    existing test fixtures. When omitted, the endpoints that need them return
    503; when set (by `docket serve`), pins/suggestions/prompts/settings/
    scopes/providers/sync/status work end-to-end.
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
    )
    app.state.conn = conn
    app.state.provider = provider
    app.state.bearer_token = bearer_token
    app.state.proposals = proposals if proposals is not None else ProposalStore()
    app.state.llm = llm
    app.state.compaction_threshold_tokens = compaction_threshold_tokens
    app.state.read_only = read_only
    app.state.paths = paths
    app.state.runtime = runtime
    app.state.setup_token = setup_token

    if llm is not None:
        registry = ToolRegistry()
        register_readonly_tools(registry, conn=conn, provider=provider)
        if not read_only:
            register_mutating_tools(
                registry,
                conn=conn,
                store=app.state.proposals,
                active_item=active_item or (lambda: None),
            )
        app.state.agent = AgentLoop(client=llm, tools=registry)
    else:
        app.state.agent = None

    app.include_router(items_routes.router)
    app.include_router(mutations_routes.router)
    app.include_router(conversations_routes.router)
    app.include_router(pins_routes.router)
    app.include_router(suggestions_routes.router)
    app.include_router(prompts_routes.router)
    app.include_router(settings_routes.router)
    app.include_router(scopes_routes.router)
    app.include_router(providers_routes.router)
    app.include_router(sync_routes.router)
    app.include_router(status_routes.router)
    app.include_router(setup_routes.router)

    @app.get("/healthz", response_model=HealthDTO, tags=["health"])
    def healthz() -> HealthDTO:
        return HealthDTO()

    @app.get("/whoami", tags=["health"], dependencies=[Depends(require_bearer)])
    def whoami() -> dict[str, str]:
        return {"app": "docket", "status": "ok"}

    return app


__all__ = ["create_app"]
