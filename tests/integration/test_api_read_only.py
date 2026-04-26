"""Read-only mode on the HTTP surface.

Verifies `create_app(..., read_only=True)`:
  - returns 403 on every POST under `/items/{id}/mutations/*`
  - returns 403 on `POST /items` (create)
  - keeps all reads (`GET /items`, `GET /items/{id}`, `/health`, `/whoami`)
    working unchanged
  - strips the mutating tools from the agent registry so the in-process
    agent can still chat but can't stage writes

The TUI and CLI surfaces are covered in their own test modules — this
file is strictly the HTTP API's contract."""

from __future__ import annotations

import base64
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.api.runtime import RuntimeState
from docket.config import Config, ProviderEntry, ScopeFilter
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.llm import FakeLlmClient
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem):
    conn = init_db(tmp_path / "docket.db")
    item = make_item(provider_key="main")
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    proposals = ProposalStore()
    config = Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={"default": ScopeFilter(assignee="")},
                active_scope="default",
            )
        },
        active_provider="main",
    )
    runtime = RuntimeState(
        config=config,
        providers={"main": provider},
        provider_key="main",
        scope_key="default",
    )
    yield conn, provider, proposals, config, runtime
    conn.close()


@pytest.fixture
def ro_client(env) -> TestClient:
    conn, provider, proposals, config, runtime = env
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        read_only=True,
        runtime=runtime,
        config=config,
    )
    return TestClient(app)


def test_create_item_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items",
        headers=AUTH,
        json={"kind": "task", "title": "Nope"},
    )
    assert resp.status_code == 403
    assert "read-only" in resp.json()["detail"].lower()


def test_create_item_confirm_also_blocked(ro_client: TestClient) -> None:
    # Every step of the create proposal pipeline is blocked in read-only
    # mode — callers should never even see a staged proposal they can't apply.
    resp = ro_client.post(
        "/api/items/proposals/any-id/confirm",
        headers=AUTH,
    )
    assert resp.status_code == 403
    resp = ro_client.post(
        "/api/items/proposals/any-id/reject",
        headers=AUTH,
    )
    assert resp.status_code == 403


def test_propose_transition_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items/S-1/mutations/transition/propose",
        headers=AUTH,
        json={"intent": "start_work"},
    )
    assert resp.status_code == 403


def test_propose_description_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items/S-1/mutations/description/propose",
        headers=AUTH,
        json={"new_description_md": "body"},
    )
    assert resp.status_code == 403


def test_propose_attachment_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items/S-1/mutations/attachment/propose",
        headers=AUTH,
        json={
            "filename": "x.md",
            "content_base64": base64.b64encode(b"x").decode("ascii"),
        },
    )
    assert resp.status_code == 403


def test_propose_comment_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items/S-1/mutations/comment/propose",
        headers=AUTH,
        json={"body_md": "hello"},
    )
    assert resp.status_code == 403


def test_confirm_blocked(ro_client: TestClient) -> None:
    # The proposal id doesn't need to exist — the router-level guard
    # fires before the handler runs.
    resp = ro_client.post(
        "/api/items/S-1/mutations/anything/confirm",
        headers=AUTH,
    )
    assert resp.status_code == 403


def test_reject_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/api/items/S-1/mutations/anything/reject",
        headers=AUTH,
    )
    assert resp.status_code == 403


def test_reads_still_work(ro_client: TestClient) -> None:
    assert ro_client.get("/api/health").status_code == 200
    assert ro_client.get("/api/whoami", headers=AUTH).status_code == 200
    listing = ro_client.get("/api/items", headers=AUTH)
    assert listing.status_code == 200
    assert len(listing.json()) == 1
    get_one = ro_client.get("/api/items/S-1", headers=AUTH)
    assert get_one.status_code == 200


def test_agent_registry_lacks_mutating_tools(env) -> None:
    conn, provider, proposals, config, runtime = env
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        llm=FakeLlmClient(),
        read_only=True,
        runtime=runtime,
        config=config,
    )
    assert app.state.agent is not None
    registry = app.state.agent._tools  # type: ignore[attr-defined]
    assert "get_item" in registry
    assert "propose_transition" not in registry
    assert "propose_description_patch" not in registry
    assert "propose_new_item" not in registry
    assert "attach_transcript" not in registry
    assert "propose_comment" not in registry


def test_writable_default_keeps_mutations(env) -> None:
    """Sanity: without read_only, POSTs go through as before."""
    conn, provider, proposals, config, runtime = env
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        runtime=runtime,
        config=config,
    )
    client = TestClient(app)
    resp = client.post(
        "/api/items/S-1/mutations/transition/propose",
        headers=AUTH,
        json={"intent": "start_work"},
    )
    assert resp.status_code == 200
