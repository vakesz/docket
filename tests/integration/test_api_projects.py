"""HTTP smoke tests for /projects routes."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.api.runtime import RuntimeState
from docket.config import Config, ProviderEntry, ScopeFilter, save_config
from docket.config.paths import resolve_paths
from docket.core.model import project_id_for
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_xdg: Path, make_item: MakeItem) -> TestClient:
    paths = resolve_paths()
    paths.ensure()
    conn = init_db(paths.db_file)
    item_repo.upsert_item(conn, make_item(description_md=""))
    config = Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="main",
        http={"enabled": True, "bind": "127.0.0.1", "port": 8765, "token": TOKEN},
    )
    save_config(paths, config)
    provider = FakeProvider(items=[make_item(description_md="")])
    runtime = RuntimeState(
        config=config,
        providers={"main": provider},
        provider_key="main",
        scope_key="default",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=ProposalStore(),
        paths=paths,
        runtime=runtime,
        config=config,
    )
    yield TestClient(app)
    conn.close()


def test_active_project_seeds_a_default_entry(client: TestClient) -> None:
    resp = client.get("/api/projects/active", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["active"] is True
    assert body["provider_key"] == "main"
    assert "scope_key" not in body
    assert body["id"] == project_id_for("main")
    assert body["name"]  # default-named


def test_list_projects_returns_active_flag(client: TestClient) -> None:
    # Force a row to exist
    client.get("/api/projects/active", headers=AUTH_HEADERS)
    resp = client.get("/api/projects", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["active"] is True


def test_patch_project_persists_to_config(client: TestClient) -> None:
    pid = project_id_for("main")
    # Seed the entry first.
    client.get("/api/projects/active", headers=AUTH_HEADERS)
    resp = client.patch(
        f"/api/projects/{pid}",
        json={"name": "Renamed", "description": "Triage queue"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "Renamed"
    assert body["description"] == "Triage queue"

    # Re-read via GET
    resp2 = client.get(f"/api/projects/{pid}", headers=AUTH_HEADERS)
    assert resp2.json()["name"] == "Renamed"


def test_get_unknown_project_returns_404(client: TestClient) -> None:
    resp = client.get("/api/projects/nope", headers=AUTH_HEADERS)
    assert resp.status_code == 404
