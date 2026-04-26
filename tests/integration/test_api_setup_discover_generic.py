"""Placeholder for the generic discovery endpoint introduced in Phase 4.

Phase 4 of the provider-independence refactor (see
`.docs/PROVIDER_INDEPENDENCE_PLAN.md`) collapses
`/api/setup/azure-devops/discover` and `/api/setup/github/discover` into one
generic endpoint:

    POST /api/setup/providers/{type_id}/discover
    request:  {stage: str, payload: dict[str, str]}
    response: {ok: bool, items: [DiscoveryItem], error: str | None}

These tests are `xfail(strict=True)` until that lands. When Phase 4 ships,
strict-xfail will flip them green automatically and `pytest --runxfail`
will show what's left to wire up. The placeholder is here today so a
contributor opening Phase 4 has a regression target without having to
guess the route shape."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_bootstrap_app
from docket.api.routes import setup as setup_routes
from docket.config.paths import Paths

SETUP_TOKEN = "setup-token-discover-placeholder"
SETUP_AUTH = {"Authorization": f"Bearer {SETUP_TOKEN}"}


def _mk_paths(tmp_path: Path) -> Paths:
    paths = Paths(
        config_dir=tmp_path / "config",
        state_dir=tmp_path / "state",
        cache_dir=tmp_path / "cache",
    )
    paths.ensure()
    return paths


@pytest.fixture(autouse=True)
def _no_restart(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(setup_routes, "_schedule_restart", lambda: None)


@pytest.mark.xfail(
    strict=True,
    reason="Phase 4: generic discovery endpoint not yet implemented",
)
def test_generic_discover_endpoint_exists(tmp_path: Path) -> None:
    """`POST /api/setup/providers/{type_id}/discover` exists and is auth-gated."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github_stub/discover",
        json={"stage": "any", "payload": {}},
        headers=SETUP_AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "items" in body
    assert isinstance(body["items"], list)


@pytest.mark.xfail(
    strict=True,
    reason="Phase 4: generic discovery endpoint not yet implemented",
)
def test_generic_discover_unknown_provider_returns_404(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/does_not_exist/discover",
        json={"stage": "any", "payload": {}},
        headers=SETUP_AUTH,
    )
    assert r.status_code == 404


@pytest.mark.xfail(
    strict=True,
    reason="Phase 4: generic discovery endpoint not yet implemented",
)
def test_generic_discover_returns_canonical_item_shape(tmp_path: Path) -> None:
    """`DiscoveryItem` rows: `{value, label, extras}` — pinned for the SPA."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        json={"stage": "orgs", "payload": {}},
        headers=SETUP_AUTH,
    )
    assert r.status_code == 200
    body = r.json()
    if body["items"]:
        first = body["items"][0]
        assert set(first.keys()) >= {"value", "label"}
        assert isinstance(first.get("extras", {}), dict)
