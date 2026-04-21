"""Read-only mode on the HTTP surface (M12).

Verifies `create_app(..., read_only=True)`:
  - returns 403 on every POST under `/items/{id}/mutations/*`
  - returns 403 on `POST /items` (create)
  - keeps all reads (`GET /items`, `GET /items/{id}`, `/healthz`, `/whoami`)
    working unchanged
  - strips the mutating tools from the agent registry so the in-process
    agent can still chat but can't stage writes

The TUI and CLI surfaces are covered in their own test modules — this
file is strictly the HTTP API's contract."""
from __future__ import annotations

import base64
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.core.model import Item, ItemKind, ItemState
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _mk_item() -> Item:
    return Item(
        id="S-1",
        kind=ItemKind.STORY,
        title="Login",
        description_md="Add login.",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "docket.db")
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider = FakeProvider(items=[item])
    proposals = ProposalStore()
    yield conn, provider, proposals
    conn.close()


@pytest.fixture
def ro_client(env) -> TestClient:
    conn, provider, proposals = env
    app = create_app(
        conn=conn, provider=provider, bearer_token=TOKEN,
        proposals=proposals, read_only=True,
    )
    return TestClient(app)


def test_create_item_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/items", headers=AUTH, json={"kind": "task", "title": "Nope"},
    )
    assert resp.status_code == 403
    assert "read-only" in resp.json()["detail"].lower()


def test_create_item_dry_run_also_blocked(ro_client: TestClient) -> None:
    # dry_run still walks the mutation pipeline; in demo-safe mode we
    # refuse the whole endpoint rather than letting callers peek at
    # proposals they could never apply.
    resp = ro_client.post(
        "/items?dry_run=true", headers=AUTH, json={"kind": "task", "title": "Nope"},
    )
    assert resp.status_code == 403


def test_propose_transition_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/items/S-1/mutations/transition/propose",
        headers=AUTH, json={"intent": "start_work"},
    )
    assert resp.status_code == 403


def test_propose_description_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/items/S-1/mutations/description/propose",
        headers=AUTH, json={"new_description_md": "body"},
    )
    assert resp.status_code == 403


def test_propose_attachment_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/items/S-1/mutations/attachment/propose",
        headers=AUTH,
        json={
            "filename": "x.md",
            "content_base64": base64.b64encode(b"x").decode("ascii"),
        },
    )
    assert resp.status_code == 403


def test_confirm_blocked(ro_client: TestClient) -> None:
    # The proposal id doesn't need to exist — the router-level guard
    # fires before the handler runs.
    resp = ro_client.post(
        "/items/S-1/mutations/anything/confirm", headers=AUTH,
    )
    assert resp.status_code == 403


def test_reject_blocked(ro_client: TestClient) -> None:
    resp = ro_client.post(
        "/items/S-1/mutations/anything/reject", headers=AUTH,
    )
    assert resp.status_code == 403


def test_reads_still_work(ro_client: TestClient) -> None:
    assert ro_client.get("/healthz").status_code == 200
    assert ro_client.get("/whoami", headers=AUTH).status_code == 200
    listing = ro_client.get("/items", headers=AUTH)
    assert listing.status_code == 200
    assert len(listing.json()) == 1
    get_one = ro_client.get("/items/S-1", headers=AUTH)
    assert get_one.status_code == 200


def test_agent_registry_lacks_mutating_tools(env) -> None:
    conn, provider, proposals = env
    app = create_app(
        conn=conn, provider=provider, bearer_token=TOKEN,
        proposals=proposals, llm=FakeLlmClient(), read_only=True,
    )
    assert app.state.agent is not None
    registry = app.state.agent._tools  # type: ignore[attr-defined]
    assert "get_item" in registry
    assert "propose_transition" not in registry
    assert "propose_description_patch" not in registry
    assert "propose_new_item" not in registry
    assert "attach_transcript" not in registry


def test_writable_default_keeps_mutations(env) -> None:
    """Sanity: without read_only, POSTs go through as before."""
    conn, provider, proposals = env
    app = create_app(
        conn=conn, provider=provider, bearer_token=TOKEN, proposals=proposals,
    )
    client = TestClient(app)
    resp = client.post(
        "/items/S-1/mutations/transition/propose",
        headers=AUTH, json={"intent": "start_work"},
    )
    assert resp.status_code == 200
