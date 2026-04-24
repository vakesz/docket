"""HTTP mutation pipeline: propose / confirm / reject for create, transition,
description, attachment, and comment."""

from __future__ import annotations

import base64
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.core.model import ItemState
from tests.conftest import MakeItem
from tests.integration._api_fixtures import (
    AUTH_HEADERS,
    ApiEnv,
    build_api_env,
    build_client,
)


@pytest.fixture
def env(tmp_path: Path, make_item: MakeItem) -> Iterator[ApiEnv]:
    e = build_api_env(tmp_path, make_item)
    yield e
    e.conn.close()


@pytest.fixture
def client(env: ApiEnv) -> TestClient:
    return build_client(env)


# -- create (mutation pipeline) ----------------------------------------------


def test_create_stage_returns_proposal(client: TestClient) -> None:
    resp = client.post(
        "/items",
        headers=AUTH_HEADERS,
        json={"kind": "task", "title": "Do thing"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["kind"] == "item_create"
    assert body["details"]["title"] == "Do thing"
    assert body["id"]


def test_create_stage_then_confirm_commits_through_provider(
    client: TestClient, env: ApiEnv
) -> None:
    staged = client.post(
        "/items",
        headers=AUTH_HEADERS,
        json={"kind": "task", "title": "Ship it"},
    )
    assert staged.status_code == 201
    proposal_id = staged.json()["id"]

    confirmed = client.post(
        f"/items/proposals/{proposal_id}/confirm",
        headers=AUTH_HEADERS,
    )
    assert confirmed.status_code == 200
    body = confirmed.json()
    assert body["item"]["title"] == "Ship it"
    assert any(i.title == "Ship it" for i in env.provider.items)


def test_create_reject_discards_proposal(client: TestClient) -> None:
    staged = client.post(
        "/items",
        headers=AUTH_HEADERS,
        json={"kind": "task", "title": "Throwaway"},
    )
    proposal_id = staged.json()["id"]
    rejected = client.post(
        f"/items/proposals/{proposal_id}/reject",
        headers=AUTH_HEADERS,
    )
    assert rejected.status_code == 204
    # Second reject should 404 — the proposal is gone.
    follow_up = client.post(
        f"/items/proposals/{proposal_id}/reject",
        headers=AUTH_HEADERS,
    )
    assert follow_up.status_code == 404


def test_create_confirm_unknown_proposal_returns_404(client: TestClient) -> None:
    resp = client.post(
        "/items/proposals/does-not-exist/confirm",
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 404


# -- transition / description / attachment / comment -------------------------


def test_propose_transition_and_confirm(client: TestClient, env: ApiEnv) -> None:
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
    assert env.provider.get_item("S-1").state == ItemState.ACTIVE

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


def test_attachment_propose_accepts_base64(client: TestClient, env: ApiEnv) -> None:
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
    assert env.provider.uploaded[0] == ("S-1", "convo-001.md", content)


def test_attachment_rejects_bad_base64(client: TestClient) -> None:
    resp = client.post(
        "/items/S-1/mutations/attachment/propose",
        headers=AUTH_HEADERS,
        json={"filename": "x.md", "content_base64": "not-base64!"},
    )
    assert resp.status_code == 400


def test_propose_comment_and_confirm(client: TestClient, env: ApiEnv) -> None:
    propose = client.post(
        "/items/S-1/mutations/comment/propose",
        headers=AUTH_HEADERS,
        json={"body_md": "Looks good."},
    )
    assert propose.status_code == 200, propose.text
    body = propose.json()
    assert body["kind"] == "comment_add"
    assert body["item_id"] == "S-1"
    assert "Looks good." in body["diff"]

    proposal_id = body["id"]
    confirm = client.post(f"/items/S-1/mutations/{proposal_id}/confirm", headers=AUTH_HEADERS)
    assert confirm.status_code == 200, confirm.text
    payload = confirm.json()
    assert payload["comment"]["body_md"] == "Looks good."
    assert payload["comment"]["item_id"] == "S-1"
    assert env.provider.comments["S-1"][-1].body_md == "Looks good."

    listed = client.get("/items/S-1/comments", headers=AUTH_HEADERS)
    assert listed.status_code == 200
    assert [c["body_md"] for c in listed.json()] == ["Looks good."]


def test_propose_comment_rejects_empty_body(client: TestClient) -> None:
    resp = client.post(
        "/items/S-1/mutations/comment/propose",
        headers=AUTH_HEADERS,
        json={"body_md": "   \n  "},
    )
    assert resp.status_code == 400


def test_propose_comment_unknown_item_returns_404(client: TestClient) -> None:
    resp = client.post(
        "/items/UNKNOWN/mutations/comment/propose",
        headers=AUTH_HEADERS,
        json={"body_md": "hi"},
    )
    assert resp.status_code == 404
