"""HTTP smoke tests for /projects/{id}/sources and /sources/{id} routes."""

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


def _pid() -> str:
    return project_id_for("main")


def _seed_project(client: TestClient) -> None:
    """Populate `projects` table by hitting the activate endpoint."""
    resp = client.get("/api/projects/active", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text


def test_create_source_round_trips(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    resp = client.post(
        f"/api/projects/{pid}/sources",
        json={
            "title": "Login spec",
            "body_md": "## Goals\nAuth via OAuth.",
            "kind": "requirements",
            "uri": "https://example.test/spec",
            "tags": ["auth"],
        },
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["title"] == "Login spec"
    assert body["kind"] == "requirements"
    assert body["uri"] == "https://example.test/spec"
    source_id = body["id"]

    one = client.get(f"/api/sources/{source_id}", headers=AUTH_HEADERS)
    assert one.status_code == 200
    assert one.json()["body_md"].startswith("## Goals")

    lst = client.get(f"/api/projects/{pid}/sources", headers=AUTH_HEADERS)
    assert lst.status_code == 200
    body = lst.json()
    assert body["project_id"] == pid
    assert "revision" not in body  # sources don't carry a revision counter
    assert len(body["entries"]) == 1


def test_list_sources_kind_filter(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "A", "body_md": "x", "kind": "design"},
        headers=AUTH_HEADERS,
    )
    client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "B", "body_md": "y", "kind": "runbook"},
        headers=AUTH_HEADERS,
    )
    resp = client.get(
        f"/api/projects/{pid}/sources",
        params={"kind": "design"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [e["title"] for e in body["entries"]] == ["A"]


def test_patch_source_updates_fields(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    created = client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "Old", "body_md": "x"},
        headers=AUTH_HEADERS,
    ).json()
    resp = client.patch(
        f"/api/sources/{created['id']}",
        json={"title": "New"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "New"
    assert body["body_md"] == "x"


def test_patch_source_requires_at_least_one_field(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    created = client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "x", "body_md": "y"},
        headers=AUTH_HEADERS,
    ).json()
    resp = client.patch(
        f"/api/sources/{created['id']}",
        json={},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 400


def test_delete_source(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    created = client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "Tmp", "body_md": ""},
        headers=AUTH_HEADERS,
    ).json()
    resp = client.delete(f"/api/sources/{created['id']}", headers=AUTH_HEADERS)
    assert resp.status_code == 204
    assert client.get(f"/api/sources/{created['id']}", headers=AUTH_HEADERS).status_code == 404


def test_search_sources(client: TestClient) -> None:
    _seed_project(client)
    pid = _pid()
    client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "Auth", "body_md": "OAuth tokens"},
        headers=AUTH_HEADERS,
    )
    client.post(
        f"/api/projects/{pid}/sources",
        json={"title": "Other", "body_md": "unrelated"},
        headers=AUTH_HEADERS,
    )
    resp = client.get(
        f"/api/projects/{pid}/sources/search",
        params={"q": "OAuth"},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert [e["title"] for e in body["entries"]] == ["Auth"]


def test_unknown_project_returns_404(client: TestClient) -> None:
    resp = client.get("/api/projects/ghost/sources", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_source_routes_require_auth(client: TestClient) -> None:
    pid = _pid()
    assert client.get(f"/api/projects/{pid}/sources").status_code == 401
