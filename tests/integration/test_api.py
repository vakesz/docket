from __future__ import annotations

import base64
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.core.model import Item, ItemKind, ItemState
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient, text_turn, tool_turn
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def _mk_item(id_: str = "S-1", title: str = "Login") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title=title,
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
    yield conn, provider, proposals, item
    conn.close()


@pytest.fixture
def client(env) -> TestClient:
    conn, provider, proposals, _ = env
    app = create_app(conn=conn, provider=provider, bearer_token=TOKEN, proposals=proposals)
    return TestClient(app)


# -- auth --------------------------------------------------------------------


def test_missing_bearer_returns_401(client: TestClient) -> None:
    resp = client.get("/items")
    assert resp.status_code == 401


def test_wrong_bearer_returns_401(client: TestClient) -> None:
    resp = client.get("/items", headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401


def test_health_is_unauthenticated(client: TestClient) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_whoami_requires_auth(client: TestClient) -> None:
    assert client.get("/whoami").status_code == 401
    resp = client.get("/whoami", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["app"] == "docket"


def test_empty_token_refused_by_factory(env) -> None:
    conn, provider, proposals, _ = env
    with pytest.raises(ValueError):
        create_app(conn=conn, provider=provider, bearer_token="", proposals=proposals)


# -- reads -------------------------------------------------------------------


def test_list_items(client: TestClient) -> None:
    resp = client.get("/items", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == "S-1"
    assert body[0]["kind"] == "story"


def test_get_item_by_id(client: TestClient) -> None:
    resp = client.get("/items/S-1", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["title"] == "Login"


def test_get_item_404(client: TestClient) -> None:
    resp = client.get("/items/nope", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_linked_delegates_to_provider(client: TestClient, env) -> None:
    _, _, _, _ = env
    resp = client.get("/items/S-1/linked", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == []


# -- create (mutation pipeline) ---------------------------------------------


def test_create_dry_run_returns_proposal(client: TestClient) -> None:
    resp = client.post(
        "/items?dry_run=true",
        headers=AUTH_HEADERS,
        json={"kind": "task", "title": "Do thing"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["kind"] == "item_create"
    assert body["details"]["title"] == "Do thing"


def test_create_commits_through_provider(client: TestClient, env) -> None:
    _, provider, _, _ = env
    resp = client.post(
        "/items",
        headers=AUTH_HEADERS,
        json={"kind": "task", "title": "Ship it"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["item"]["title"] == "Ship it"
    assert any(i.title == "Ship it" for i in provider.items)


# -- mutation propose/confirm/reject -----------------------------------------


def test_propose_transition_and_confirm(client: TestClient, env) -> None:
    _, provider, _, _ = env
    propose = client.post(
        "/items/S-1/mutations/transition/propose",
        headers=AUTH_HEADERS,
        json={"intent": "start_work"},
    )
    assert propose.status_code == 200
    proposal_id = propose.json()["id"]

    # GET it back
    fetched = client.get(f"/items/S-1/mutations/{proposal_id}", headers=AUTH_HEADERS)
    assert fetched.status_code == 200

    confirm = client.post(f"/items/S-1/mutations/{proposal_id}/confirm", headers=AUTH_HEADERS)
    assert confirm.status_code == 200
    assert confirm.json()["item"]["state"] == "active"
    # Provider now reports active too
    assert provider.get_item("S-1").state == ItemState.ACTIVE

    # Second confirm → 404 (consumed)
    again = client.post(f"/items/S-1/mutations/{proposal_id}/confirm", headers=AUTH_HEADERS)
    assert again.status_code == 404


def test_reject_discards_proposal(client: TestClient) -> None:
    propose = client.post(
        "/items/S-1/mutations/description/propose",
        headers=AUTH_HEADERS,
        json={"new_description_md": "New body."},
    )
    proposal_id = propose.json()["id"]
    reject = client.post(f"/items/S-1/mutations/{proposal_id}/reject", headers=AUTH_HEADERS)
    assert reject.status_code == 204
    # Gone
    again = client.post(f"/items/S-1/mutations/{proposal_id}/confirm", headers=AUTH_HEADERS)
    assert again.status_code == 404


def test_attachment_propose_accepts_base64(client: TestClient, env) -> None:
    _, provider, _, _ = env
    content = b"# transcript\n"
    propose = client.post(
        "/items/S-1/mutations/attachment/propose",
        headers=AUTH_HEADERS,
        json={
            "filename": "convo-001.md",
            "content_base64": base64.b64encode(content).decode("ascii"),
        },
    )
    assert propose.status_code == 200
    proposal_id = propose.json()["id"]
    confirm = client.post(f"/items/S-1/mutations/{proposal_id}/confirm", headers=AUTH_HEADERS)
    assert confirm.status_code == 200
    assert confirm.json()["attachment_url"].endswith("convo-001.md")
    assert provider.uploaded[0] == ("S-1", "convo-001.md", content)


def test_attachment_rejects_bad_base64(client: TestClient) -> None:
    resp = client.post(
        "/items/S-1/mutations/attachment/propose",
        headers=AUTH_HEADERS,
        json={"filename": "x.md", "content_base64": "not-base64!"},
    )
    assert resp.status_code == 400


# -- conversations & SSE -----------------------------------------------------


def test_conversation_history_empty_when_no_thread(client: TestClient) -> None:
    resp = client.get("/items/S-1/conversation", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation"] is None
    assert body["messages"] == []


def test_conversation_requires_llm(client: TestClient) -> None:
    resp = client.post(
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "hi"},
    )
    assert resp.status_code == 503


def test_sse_streams_delta_and_done(env) -> None:
    conn, provider, proposals, _ = env
    llm = FakeLlmClient(script=[text_turn("hello world")])
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        llm=llm,
    )
    client = TestClient(app)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "summarize"},
    ) as resp:
        assert resp.status_code == 200
        events = _parse_sse(resp.iter_lines())

    event_types = [e["event"] for e in events]
    assert event_types.count("delta") > 0
    assert "done" in event_types
    # Concatenated delta text should reconstruct the reply.
    text = "".join(json.loads(e["data"])["text"] for e in events if e["event"] == "delta")
    assert text == "hello world"


def test_sse_emits_proposal_event_when_agent_stages_mutation(env) -> None:
    conn, provider, proposals, _ = env
    # Turn 1: the agent calls propose_transition; turn 2: it replies.
    llm = FakeLlmClient(
        script=[
            tool_turn("tc-1", "propose_transition", '{"id":"S-1","intent":"start_work"}'),
            text_turn("proposed"),
        ]
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        llm=llm,
    )
    client = TestClient(app)

    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "start work"},
    ) as resp:
        assert resp.status_code == 200
        events = _parse_sse(resp.iter_lines())

    proposals_seen = [e for e in events if e["event"] == "proposal"]
    assert len(proposals_seen) == 1
    payload = json.loads(proposals_seen[0]["data"])
    assert payload["kind"] == "state_change"
    assert payload["item_id"] == "S-1"
    # The proposal is now confirmable via the REST endpoint.
    pid = payload["id"]
    confirm = client.post(f"/items/S-1/mutations/{pid}/confirm", headers=AUTH_HEADERS)
    assert confirm.status_code == 200


def test_new_thread_archives_previous(env) -> None:
    conn, provider, proposals, _ = env
    llm = FakeLlmClient(script=[text_turn("ack")])
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=proposals,
        llm=llm,
    )
    client = TestClient(app)

    # Seed a conversation.
    with client.stream(
        "POST",
        "/items/S-1/conversation/messages",
        headers=AUTH_HEADERS,
        json={"text": "hi"},
    ) as r:
        list(r.iter_lines())

    new = client.post("/items/S-1/conversation/thread", headers=AUTH_HEADERS)
    assert new.status_code == 200
    # History is now empty against the new thread.
    history = client.get("/items/S-1/conversation", headers=AUTH_HEADERS).json()
    assert history["messages"] == []


# -- helpers ----------------------------------------------------------------


def _parse_sse(lines) -> list[dict[str, str]]:
    """Parse sse-starlette output into [{event, data}, …]."""
    events: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for raw in lines:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        if raw == "":
            if current:
                events.append(current)
                current = {}
            continue
        if raw.startswith(":"):  # comment / keepalive
            continue
        if ":" not in raw:
            continue
        field, _, value = raw.partition(":")
        value = value.lstrip()
        if field == "event":
            current["event"] = value
        elif field == "data":
            current["data"] = current.get("data", "") + value
    if current:
        events.append(current)
    return events
