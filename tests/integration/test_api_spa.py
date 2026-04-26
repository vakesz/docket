"""SPA mount: `docket serve` ships the built React bundle in-process so a
single FastAPI origin serves both the API and the static client. These
tests cover the three modes of the catch-all route — bundle present,
bundle missing, deep-link fallback — plus the bearer-token injection that
keeps same-origin auth identical to the old Bun-proxy era."""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.conftest import MakeItem

from ._api_fixtures import AUTH_HEADERS, build_api_env, build_client


@pytest.fixture
def fake_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Build a fake `frontend/dist` shaped like the real vite output."""
    dist = tmp_path / "fake-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><html><head><title>Docket</title></head>"
        "<body><div id=root></div></body></html>",
        encoding="utf-8",
    )
    (dist / "assets" / "app-deadbeef.js").write_text("console.log('hi');\n", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(dist))
    return dist


@pytest.fixture
def no_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Pin the SPA resolver to a directory that doesn't exist so the
    fallback page renders, isolated from the real repo's `frontend/dist`."""
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(tmp_path / "missing"))


def test_index_serves_built_html_with_token_injected(
    tmp_path: Path, make_item: MakeItem, fake_dist: Path
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    body = res.text
    assert "<div id=root>" in body
    # Token injection: window.__DOCKET_TOKEN__ must contain the bearer.
    assert "window.__DOCKET_TOKEN__" in body
    assert '"test-bearer-token-abcdef"' in body


def test_deep_link_returns_index_html(tmp_path: Path, make_item: MakeItem, fake_dist: Path) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/items/123")
    assert res.status_code == 200
    assert "<div id=root>" in res.text


def test_static_asset_served_from_dist(
    tmp_path: Path, make_item: MakeItem, fake_dist: Path
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/assets/app-deadbeef.js")
    assert res.status_code == 200
    assert "console.log" in res.text


def test_top_level_static_file_served(tmp_path: Path, make_item: MakeItem, fake_dist: Path) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/favicon.svg")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("image/svg")


def test_api_route_still_requires_bearer_with_spa_mounted(
    tmp_path: Path, make_item: MakeItem, fake_dist: Path
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    unauth = client.get("/api/items")
    assert unauth.status_code in (401, 403)
    auth = client.get("/api/items", headers=AUTH_HEADERS)
    assert auth.status_code == 200


def test_missing_bundle_renders_fallback(
    tmp_path: Path, make_item: MakeItem, no_dist: None
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/")
    assert res.status_code == 200
    assert "frontend bundle not built" in res.text.lower()


def test_missing_bundle_deep_link_renders_fallback(
    tmp_path: Path, make_item: MakeItem, no_dist: None
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    res = client.get("/items/42")
    assert res.status_code == 200
    assert "frontend bundle not built" in res.text.lower()


def test_missing_bundle_does_not_shadow_api(
    tmp_path: Path, make_item: MakeItem, no_dist: None
) -> None:
    env = build_api_env(tmp_path, make_item)
    client = build_client(env)

    # Authenticated API call still works, doesn't get the HTML fallback.
    res = client.get("/api/items", headers=AUTH_HEADERS)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
