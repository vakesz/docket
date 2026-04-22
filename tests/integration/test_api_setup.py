"""Tests for the /setup/* surface and the bootstrap app.

Two modes are covered:

- **bootstrap app** (no config.toml yet): only `/health` and `/setup/*` are
  mounted, auth uses `DOCKET_SETUP_TOKEN`.
- **full app** with setup routes mounted alongside normal endpoints, so an
  operator can re-run setup after config exists.

We mock out the self-restart signal path so the process doesn't die while the
test client is still reading the response."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app, create_bootstrap_app
from docket.api.routes import setup as setup_routes
from docket.api.runtime import RuntimeState
from docket.config.models import Config, HttpConfig, ProviderEntry, ScopeFilter
from docket.config.paths import Paths
from docket.storage import init_db
from tests.fakes.provider import FakeProvider

SETUP_TOKEN = "setup-token-abcdef123"
BEARER_TOKEN = "bearer-token-xyz789"
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
    """Stub out the SIGTERM-on-self background task."""
    monkeypatch.setattr(setup_routes, "_schedule_restart", lambda: None)


# ---- bootstrap app (no config.toml yet) -------------------------------------


def test_bootstrap_app_requires_setup_token(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    with pytest.raises(ValueError, match="DOCKET_SETUP_TOKEN"):
        create_bootstrap_app(paths=paths, setup_token="")


def test_bootstrap_status_no_auth(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_setup"] is True
    assert body["providers_configured"] == 0
    assert body["active_provider"] == ""
    assert body["config_path"].endswith("config.toml")


def test_bootstrap_health_works(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/health")
    assert r.status_code == 200


def test_bootstrap_provider_types_requires_auth(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    assert client.get("/setup/providers/types").status_code == 401
    r = client.get("/setup/providers/types", headers=SETUP_AUTH)
    assert r.status_code == 200
    ids = {t["id"] for t in r.json()}
    assert {"azure_devops", "github", "github_stub"}.issubset(ids)


def test_bootstrap_provider_types_wrong_token_rejected(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get(
        "/setup/providers/types",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert r.status_code == 401


def test_bootstrap_test_provider_github_stub_ok(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/setup/test-provider",
        headers=SETUP_AUTH,
        json={"type": "github_stub", "config": {"default_repo": "demo/repo"}},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "error": None}


def test_bootstrap_test_provider_unknown_type_reports_error(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/setup/test-provider",
        headers=SETUP_AUTH,
        json={"type": "nonexistent", "config": {}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "nonexistent" in body["error"]


def test_bootstrap_test_provider_ado_missing_fields(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/setup/test-provider",
        headers=SETUP_AUTH,
        json={"type": "azure_devops", "config": {}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False


def test_bootstrap_test_llm_missing_credentials(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/setup/test-llm",
        headers=SETUP_AUTH,
        json={"endpoint": "", "api_key": ""},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "required" in body["error"]


def test_bootstrap_complete_writes_config_and_runs_sync(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    payload: dict[str, Any] = {
        "providers": {
            "demo": {
                "type": "github_stub",
                "display_name": "Demo GitHub",
                "config": {"default_repo": "example/demo"},
                "scope": {"assignee": "@me"},
            }
        },
        "active_provider": "demo",
        "llm": None,
        "http_bind": "0.0.0.0",
        "http_port": 9000,
        "http_token": "",
        "telemetry_enabled": False,
        "run_initial_sync": True,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["restart_required"] is True
    assert len(body["http_token"]) >= 20
    assert body["initial_sync"] is not None
    assert body["initial_sync"]["upserted"] == 0

    # Config on disk reflects what we POSTed.
    assert paths.config_file.exists()
    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    assert raw["active_provider"] == "demo"
    assert raw["providers"]["demo"]["type"] == "github_stub"
    assert raw["providers"]["demo"]["config"]["default_repo"] == "example/demo"
    assert raw["http"]["enabled"] is True
    assert raw["http"]["bind"] == "0.0.0.0"
    assert raw["http"]["port"] == 9000
    assert raw["http"]["token"] == body["http_token"]
    assert raw["telemetry"]["enabled"] is False

    # Scaffolded prompt templates land in the prompts dir.
    assert paths.prompts_dir.exists()
    assert any(paths.prompts_dir.glob("*.md"))


def test_bootstrap_complete_uses_provided_token(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    payload = {
        "providers": {
            "demo": {
                "type": "github_stub",
                "display_name": "Demo",
                "config": {"default_repo": "example/demo"},
                "scope": {},
            }
        },
        "active_provider": "demo",
        "llm": None,
        "http_token": "operator-supplied-token-123",
        "run_initial_sync": False,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200
    assert r.json()["http_token"] == "operator-supplied-token-123"


def test_bootstrap_complete_rejects_mismatched_active_provider(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    payload = {
        "providers": {
            "demo": {
                "type": "github_stub",
                "config": {"default_repo": "example/demo"},
            }
        },
        "active_provider": "missing",
        "run_initial_sync": False,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 422
    assert "active_provider" in r.text


def test_bootstrap_complete_rejects_empty_providers(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/setup/complete",
        headers=SETUP_AUTH,
        json={"providers": {}, "active_provider": "x", "run_initial_sync": False},
    )
    assert r.status_code == 422


def test_bootstrap_complete_llm_persists_api_key_to_env_file(
    tmp_path: Path,
) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    payload = {
        "providers": {
            "demo": {
                "type": "github_stub",
                "config": {"default_repo": "example/demo"},
            }
        },
        "active_provider": "demo",
        "llm": {
            "endpoint": "https://example.cognitiveservices.azure.com/",
            "api_key": "sk-test-1234567890",
            "deployment": "gpt-5-mini",
        },
        "http_token": "token-1",
        "run_initial_sync": False,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text
    env_path = paths.env_file
    assert env_path.exists()
    assert "AZURE_OPENAI_API_KEY=sk-test-1234567890" in env_path.read_text()
    # The config.toml stores the llm endpoint + deployment but NOT the api key.
    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    assert raw["llm"]["deployment"] == "gpt-5-mini"
    assert "api_key" not in raw["llm"]


# ---- full app (setup router also mounted alongside normal routes) -----------


def _full_app_client(tmp_path: Path) -> TestClient:
    paths = _mk_paths(tmp_path)
    cfg = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/primary"},
                scopes={"default": ScopeFilter(assignee="@me")},
                active_scope="default",
            )
        },
        active_provider="primary",
        http=HttpConfig(enabled=True, token=BEARER_TOKEN),
    )
    # Write the config so /setup/status reports "already configured".
    from docket.config.loader import save_config

    save_config(paths, cfg)

    conn = init_db(paths.db_file)
    provider = FakeProvider()
    runtime = RuntimeState(
        config=cfg, providers={"primary": provider}, provider_key="primary", scope_key="default"
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=BEARER_TOKEN,
        paths=paths,
        runtime=runtime,
        setup_token=SETUP_TOKEN,
    )
    return TestClient(app)


def test_full_app_setup_status_reports_configured(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get("/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_setup"] is False
    assert body["providers_configured"] == 1
    assert body["active_provider"] == "primary"
    assert body["http_configured"] is True


def test_full_app_setup_accepts_regular_bearer_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get(
        "/setup/providers/types",
        headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
    )
    assert r.status_code == 200


def test_full_app_setup_accepts_setup_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get("/setup/providers/types", headers=SETUP_AUTH)
    assert r.status_code == 200


def test_full_app_setup_rejects_unknown_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get("/setup/providers/types", headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
