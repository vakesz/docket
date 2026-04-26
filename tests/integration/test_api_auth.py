"""HTTP auth + health surface for the FastAPI app."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
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


def test_missing_bearer_returns_401(client: TestClient) -> None:
    resp = client.get("/api/items")
    assert resp.status_code == 401


def test_wrong_bearer_returns_401(client: TestClient) -> None:
    resp = client.get("/api/items", headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401


def test_health_is_unauthenticated(client: TestClient) -> None:
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_whoami_requires_auth(client: TestClient) -> None:
    assert client.get("/api/whoami").status_code == 401
    resp = client.get("/api/whoami", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["app"] == "docket"


def test_empty_token_refused_by_factory(env: ApiEnv) -> None:
    with pytest.raises(ValueError):
        create_app(
            conn=env.conn,
            provider=env.provider,
            bearer_token="",
            proposals=env.proposals,
        )
