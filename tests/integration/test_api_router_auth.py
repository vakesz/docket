"""Architectural guard: every live-mode route must require bearer auth.

`app.py` hoists `Depends(require_bearer)` onto each `include_router(...)`
call instead of having each router import the gate itself. This test pins
that contract by walking the assembled app's routes and checking that the
`require_bearer` callable appears somewhere in each route's dependency
tree — except for the small set of intentionally auth-free endpoints
(`/health` and the `/setup/*` family, which uses a setup-token gate).

If a future router slips through `app.include_router(..., dependencies=...)`
without bearer wiring, this test fails — regardless of whether handlers
themselves remembered to attach the dependency."""

from __future__ import annotations

from pathlib import Path

from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

from docket.api.auth import require_bearer
from tests.conftest import MakeItem
from tests.integration._api_fixtures import build_api_env, build_client

# Routes that legitimately bypass the bearer gate. `/setup/*` uses
# `require_setup_token` (a one-shot bootstrap secret, not the API token);
# `/health` is unauthenticated by design so monitors can probe liveness;
# `/openapi.json`, `/docs`, `/redoc` are framework-provided.
_AUTH_FREE_PREFIXES = ("/health", "/setup", "/openapi", "/docs", "/redoc")


def _flatten(dep: Dependant) -> list[Dependant]:
    out = [dep]
    for sub in dep.dependencies:
        out.extend(_flatten(sub))
    return out


def _has_require_bearer(route: APIRoute) -> bool:
    return any(d.call is require_bearer for d in _flatten(route.dependant))


def test_every_route_requires_bearer_or_is_explicitly_auth_free(
    tmp_path: Path, make_item: MakeItem
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)
    try:
        offenders: list[str] = []
        for route in client.app.routes:
            if not isinstance(route, APIRoute):
                continue
            if route.path.startswith(_AUTH_FREE_PREFIXES):
                continue
            if not _has_require_bearer(route):
                offenders.append(f"{','.join(sorted(route.methods))} {route.path}")
        assert not offenders, "routes missing require_bearer: " + ", ".join(offenders)
    finally:
        env.conn.close()
