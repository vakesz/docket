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
from docket.config.models import (
    Config,
    HttpConfig,
    LlmConfig,
    ProviderEntry,
    ScopeFilter,
    StaleConfig,
    SyncConfig,
    UiConfig,
)
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


def test_bootstrap_test_provider_azure_devops_missing_fields(tmp_path: Path) -> None:
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


def test_setup_complete_preserves_existing_scopes_and_active_slot(tmp_path: Path) -> None:
    """Re-running /setup/complete against a configured instance must keep extra
    named scopes and the user's active-scope choice — the incoming scope should
    land in whatever slot was already active, not clobber it with a new
    'default' slot."""
    paths = _mk_paths(tmp_path)
    existing = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/primary"},
                scopes={
                    "default": ScopeFilter(),
                    "my-team": ScopeFilter(team="Team A"),
                    "blocked": ScopeFilter(area_path="Blocked"),
                },
                active_scope="my-team",
            )
        },
        active_provider="primary",
        http=HttpConfig(enabled=True, token=BEARER_TOKEN),
    )
    from docket.config.loader import save_config

    save_config(paths, existing)
    conn = init_db(paths.db_file)
    provider = FakeProvider()
    runtime = RuntimeState(
        config=existing,
        providers={"primary": provider},
        provider_key="primary",
        scope_key="my-team",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=BEARER_TOKEN,
        paths=paths,
        runtime=runtime,
        setup_token=SETUP_TOKEN,
    )
    client = TestClient(app)

    payload: dict[str, Any] = {
        "providers": {
            "primary": {
                "type": "github_stub",
                "display_name": "Primary",
                "config": {"default_repo": "example/primary"},
                "scope": {"team": "Team B"},
            }
        },
        "active_provider": "primary",
        "llm": None,
        "http_token": BEARER_TOKEN,
        "run_initial_sync": False,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text

    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    entry = raw["providers"]["primary"]
    # active_scope preserved at "my-team" (not silently reset to "default").
    assert entry["active_scope"] == "my-team"
    # The user's incoming edit landed in the my-team slot.
    assert entry["scopes"]["my-team"]["team"] == "Team B"
    # Extra scopes ("default", "blocked") are still present and unchanged.
    assert entry["scopes"]["default"]["team"] == ""
    assert entry["scopes"]["blocked"]["area_path"] == "Blocked"


def test_setup_complete_preserves_non_wizard_fields(tmp_path: Path) -> None:
    """`ui`, `sync`, `stale`, and LLM advanced knobs (`compaction_threshold_tokens`,
    `external_watch_interval_seconds`) are not surfaced by the wizard. Re-running
    /setup/complete must keep the existing values instead of snapping them back
    to pydantic defaults."""
    paths = _mk_paths(tmp_path)
    existing = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/primary"},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="primary",
        http=HttpConfig(enabled=True, token=BEARER_TOKEN),
        llm=LlmConfig(
            deployment="gpt-5",
            compaction_threshold_tokens=12345,
            external_watch_interval_seconds=17.5,
        ),
        ui=UiConfig(theme="textual-light", hide_done=False, tag_filter_collapse_limit=9),
        sync=SyncConfig(
            background_interval_seconds=42.0,
            min_interval_seconds_by_provider={"primary": 15.0},
        ),
        stale=StaleConfig(
            threshold_days=3,
            threshold_days_by_provider={"primary": 5},
        ),
    )
    from docket.config.loader import save_config

    save_config(paths, existing)
    conn = init_db(paths.db_file)
    provider = FakeProvider()
    runtime = RuntimeState(
        config=existing,
        providers={"primary": provider},
        provider_key="primary",
        scope_key="default",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=BEARER_TOKEN,
        paths=paths,
        runtime=runtime,
        setup_token=SETUP_TOKEN,
    )
    client = TestClient(app)

    payload: dict[str, Any] = {
        "providers": {
            "primary": {
                "type": "github_stub",
                "display_name": "Primary",
                "config": {"default_repo": "example/primary"},
                "scope": {"team": "Team C"},
            }
        },
        "active_provider": "primary",
        "llm": {
            "endpoint": "https://example.cognitiveservices.azure.com/",
            "api_key": "",
            "deployment": "gpt-5-mini",
        },
        "http_token": BEARER_TOKEN,
        "run_initial_sync": False,
    }
    r = client.post("/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text

    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    # Wizard-surfaced LLM fields updated, advanced knobs preserved.
    assert raw["llm"]["deployment"] == "gpt-5-mini"
    assert raw["llm"]["compaction_threshold_tokens"] == 12345
    assert raw["llm"]["external_watch_interval_seconds"] == 17.5
    # ui / sync / stale never touched by the wizard — must survive intact.
    assert raw["ui"]["theme"] == "textual-light"
    assert raw["ui"]["hide_done"] is False
    assert raw["ui"]["tag_filter_collapse_limit"] == 9
    assert raw["sync"]["background_interval_seconds"] == 42.0
    assert raw["sync"]["min_interval_seconds_by_provider"]["primary"] == 15.0
    assert raw["stale"]["threshold_days"] == 3
    assert raw["stale"]["threshold_days_by_provider"]["primary"] == 5


def test_update_provider_preserves_active_scope_slot(tmp_path: Path) -> None:
    """PUT /settings/providers/{key} with a new scope must land the scope in
    the existing `active_scope` slot while keeping other named scopes intact."""
    paths = _mk_paths(tmp_path)
    existing = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/primary"},
                scopes={
                    "default": ScopeFilter(),
                    "my-team": ScopeFilter(team="Team A"),
                },
                active_scope="my-team",
            )
        },
        active_provider="primary",
        http=HttpConfig(enabled=True, token=BEARER_TOKEN),
    )
    from docket.config.loader import save_config

    save_config(paths, existing)
    conn = init_db(paths.db_file)
    provider = FakeProvider()
    runtime = RuntimeState(
        config=existing,
        providers={"primary": provider},
        provider_key="primary",
        scope_key="my-team",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=BEARER_TOKEN,
        paths=paths,
        runtime=runtime,
        setup_token=SETUP_TOKEN,
    )
    client = TestClient(app)

    r = client.put(
        "/settings/providers/primary",
        headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
        json={
            "display_name": "Primary",
            "config": {"default_repo": "example/primary"},
            "scope": {"team": "Team B"},
        },
    )
    assert r.status_code == 200, r.text

    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    entry = raw["providers"]["primary"]
    assert entry["active_scope"] == "my-team"
    assert entry["scopes"]["my-team"]["team"] == "Team B"
    # The other named scope is untouched.
    assert entry["scopes"]["default"]["team"] == ""
