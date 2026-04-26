"""HTTP read surface: list, filter, get, linked, search, providers."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.core.model import ItemKind, ItemState
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.integration._api_fixtures import (
    AUTH_HEADERS,
    TOKEN,
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


def test_list_items(client: TestClient) -> None:
    resp = client.get("/api/items", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == "S-1"
    assert body[0]["kind"] == "story"


def test_list_items_filters_by_state(env: ApiEnv, make_item: MakeItem) -> None:
    item_repo.upsert_item(
        env.conn,
        make_item(
            "S-2",
            title="Done",
            kind=ItemKind.TASK,
            description_md="",
            state=ItemState.CLOSED,
            provider_key="main",
        ),
    )
    client = build_client(env)
    resp = client.get("/api/items?state=new&state=active", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert [i["id"] for i in resp.json()] == ["S-1"]
    resp_closed = client.get("/api/items?state=closed", headers=AUTH_HEADERS)
    assert [i["id"] for i in resp_closed.json()] == ["S-2"]


def test_list_items_filters_by_tag(env: ApiEnv, make_item: MakeItem) -> None:
    tagged = make_item(
        "S-2",
        title="Bugfix",
        kind=ItemKind.TASK,
        description_md="",
        state=ItemState.ACTIVE,
        provider_key="main",
    )
    tagged.tags = ["bug"]
    item_repo.upsert_item(env.conn, tagged)
    client = build_client(env)
    resp = client.get("/api/items?tag=bug", headers=AUTH_HEADERS)
    assert [i["id"] for i in resp.json()] == ["S-2"]


def test_list_items_applies_active_view_assignee_filter(env: ApiEnv, make_item: MakeItem) -> None:
    env.item.assignee = "fake-user"
    item_repo.upsert_item(env.conn, env.item)
    other = make_item(
        "S-2",
        title="Other queue",
        kind=ItemKind.TASK,
        description_md="",
        state=ItemState.ACTIVE,
        assignee="someone-else",
        provider_key="main",
    )
    item_repo.upsert_item(env.conn, other)
    env.runtime.switch_view("mine")
    client = build_client(env)
    resp = client.get("/api/items", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert [row["id"] for row in resp.json()] == ["S-1"]


def test_list_items_can_disable_active_view_filter(env: ApiEnv, make_item: MakeItem) -> None:
    env.item.assignee = "fake-user"
    item_repo.upsert_item(env.conn, env.item)
    other = make_item(
        "S-2",
        title="Other queue",
        kind=ItemKind.TASK,
        description_md="",
        state=ItemState.ACTIVE,
        assignee="someone-else",
        provider_key="main",
    )
    item_repo.upsert_item(env.conn, other)
    env.runtime.switch_view("mine")
    client = build_client(env)
    resp = client.get("/api/items?apply_view=false", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert {row["id"] for row in resp.json()} == {"S-1", "S-2"}


def test_list_items_without_runtime_falls_back_to_unfiltered_listing(env: ApiEnv) -> None:
    client = TestClient(
        create_app(
            conn=env.conn,
            provider=env.provider,
            bearer_token=TOKEN,
            proposals=env.proposals,
        )
    )
    default_resp = client.get("/api/items", headers=AUTH_HEADERS)
    assert default_resp.status_code == 200
    assert [row["id"] for row in default_resp.json()] == ["S-1"]
    explicit_resp = client.get("/api/items?apply_view=false", headers=AUTH_HEADERS)
    assert explicit_resp.status_code == 200
    assert [row["id"] for row in explicit_resp.json()] == ["S-1"]


def test_get_item_by_id(client: TestClient) -> None:
    resp = client.get("/api/items/S-1", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["title"] == "Login"


def test_get_item_404(client: TestClient) -> None:
    resp = client.get("/api/items/nope", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_linked_delegates_to_provider(client: TestClient) -> None:
    resp = client.get("/api/items/S-1/linked", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == []


def test_search_items_returns_similar(client: TestClient) -> None:
    resp = client.get("/api/items/search", params={"q": "login"}, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["id"] == "S-1"


def test_search_items_empty_query(client: TestClient) -> None:
    resp = client.get("/api/items/search", params={"q": "  "}, headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json() == []


def test_providers_list_exposes_supported_kinds(client: TestClient) -> None:
    resp = client.get("/api/providers", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body, "expected at least one provider"
    kinds = body[0]["supported_kinds"]
    # github_stub (test fixture) excludes FEATURE
    assert "task" in kinds
    assert "feature" not in kinds
