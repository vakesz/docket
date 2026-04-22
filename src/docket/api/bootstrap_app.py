"""Minimal FastAPI used when `config.toml` is missing.

Only `/healthz` and `/setup/*` are exposed, gated by `DOCKET_SETUP_TOKEN`.
The frontend can poll `GET /setup/status` (auth-free) to detect this mode
and run its built-in wizard. On `POST /setup/complete` the backend writes
config and signals itself to exit so the supervisor restarts it in normal
mode."""

from __future__ import annotations

from fastapi import FastAPI

from docket.api.routes import setup as setup_routes
from docket.api.schemas import HealthDTO
from docket.config.paths import Paths


def create_bootstrap_app(*, paths: Paths, setup_token: str) -> FastAPI:
    if not setup_token:
        raise ValueError(
            "Bootstrap mode requires DOCKET_SETUP_TOKEN — set it before starting the server."
        )

    app = FastAPI(
        title="Docket (setup)",
        version="0.1.0",
        description="First-time setup surface. Only /healthz and /setup/* are exposed.",
    )
    app.state.paths = paths
    app.state.setup_token = setup_token
    # Deliberately absent: conn, provider, proposals, runtime, bearer_token.
    # Any route that depends on those will 503 — which is the right signal for
    # a frontend that reached bootstrap by mistake.
    app.state.bearer_token = ""

    app.include_router(setup_routes.router)

    @app.get("/healthz", response_model=HealthDTO, tags=["health"])
    def healthz() -> HealthDTO:
        return HealthDTO()

    return app


__all__ = ["create_bootstrap_app"]
