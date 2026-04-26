"""Tests for the /setup/* surface and the bootstrap app.

Two modes are covered:

- **bootstrap app** (no config.toml yet): only `/health` and `/setup/*` are
  mounted, auth uses the bootstrap `[http].token` minted on first `docket
  serve`.
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
    with pytest.raises(ValueError, match="bearer token"):
        create_bootstrap_app(paths=paths, setup_token="")


def test_bootstrap_status_no_auth(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/api/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_setup"] is True
    assert body["providers_configured"] == 0
    assert body["active_provider"] == ""
    assert body["config_path"].endswith("config.toml")


def test_bootstrap_health_works(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/api/health")
    assert r.status_code == 200


def test_bootstrap_provider_types_requires_auth(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    assert client.get("/api/setup/providers/types").status_code == 401
    r = client.get("/api/setup/providers/types", headers=SETUP_AUTH)
    assert r.status_code == 200
    ids = {t["id"] for t in r.json()}
    assert {"azure_devops", "github", "github_stub"}.issubset(ids)


def test_bootstrap_provider_types_wrong_token_rejected(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get(
        "/api/setup/providers/types",
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert r.status_code == 401


def test_bootstrap_test_provider_github_stub_ok(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/test-provider",
        headers=SETUP_AUTH,
        json={"type": "github_stub", "config": {"default_repo": "demo/repo"}},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "error": None}


def test_bootstrap_test_provider_unknown_type_reports_error(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/test-provider",
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
        "/api/setup/test-provider",
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
        "/api/setup/test-llm",
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 422
    assert "active_provider" in r.text


def test_bootstrap_complete_rejects_empty_providers(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/complete",
        headers=SETUP_AUTH,
        json={"providers": {}, "active_provider": "x", "run_initial_sync": False},
    )
    assert r.status_code == 422


def test_bootstrap_complete_llm_persists_api_key_to_keyring(
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text

    # The key is stored in the OS keyring (in-memory backend during tests),
    # never in config.toml.
    from docket.config.secrets import get_llm_api_key

    assert get_llm_api_key() == "sk-test-1234567890"

    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    assert raw["llm"]["deployment"] == "gpt-5-mini"
    assert "api_key" not in raw["llm"]
    # The non-secret hint should land in [llm.key_hint] for the UI preview.
    hint = raw["llm"]["key_hint"]
    assert hint["configured"] is True
    assert hint["length"] == len("sk-test-1234567890")
    assert hint["prefix"] == "sk-t"
    assert hint["suffix"] == "7890"


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
    r = client.get("/api/setup/status")
    assert r.status_code == 200
    body = r.json()
    assert body["needs_setup"] is False
    assert body["providers_configured"] == 1
    assert body["active_provider"] == "primary"
    assert body["http_configured"] is True


def test_full_app_setup_accepts_regular_bearer_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get(
        "/api/setup/providers/types",
        headers={"Authorization": f"Bearer {BEARER_TOKEN}"},
    )
    assert r.status_code == 200


def test_full_app_setup_accepts_setup_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get("/api/setup/providers/types", headers=SETUP_AUTH)
    assert r.status_code == 200


def test_full_app_setup_rejects_unknown_token(tmp_path: Path) -> None:
    client = _full_app_client(tmp_path)
    r = client.get("/api/setup/providers/types", headers={"Authorization": "Bearer nope"})
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
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
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
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
        "/api/settings/providers/primary",
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


# ---- discovery + helper endpoints (web-wizard parity with `docket setup`) ----


def test_cli_status_no_auth(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`/setup/cli-status` is auth-free so the SPA can render before the
    operator has a token. Probes `gh` and `az` via stubbed helpers."""
    paths = _mk_paths(tmp_path)
    from docket.config import setup_discovery

    monkeypatch.setattr(
        setup_discovery,
        "probe_gh",
        lambda: setup_discovery.CliToolStatus(
            name="gh", present=True, logged_in=True, identity="octocat"
        ),
    )
    monkeypatch.setattr(
        setup_discovery,
        "probe_az",
        lambda: setup_discovery.CliToolStatus(name="az", present=False, logged_in=False),
    )
    monkeypatch.setattr(
        setup_discovery,
        "list_gh_hosts",
        lambda: [setup_discovery.GhHostRef(hostname="github.com", api_base_url="api.github.com")],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/api/setup/cli-status")
    assert r.status_code == 200
    body = r.json()
    assert body["gh"]["present"] is True
    assert body["gh"]["logged_in"] is True
    assert body["gh"]["identity"] == "octocat"
    assert body["az"]["present"] is False
    assert body["gh_hosts"] == [{"hostname": "github.com", "api_base_url": "api.github.com"}]
    assert body["keyring_available"] is True  # in-memory keyring autouse fixture


def test_cli_status_skips_gh_hosts_when_logged_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When `gh` isn't signed in we don't bother enumerating hosts — the
    list_gh_hosts helper would shell out to a `gh` that can't help us."""
    paths = _mk_paths(tmp_path)
    from docket.config import setup_discovery

    monkeypatch.setattr(
        setup_discovery,
        "probe_gh",
        lambda: setup_discovery.CliToolStatus(name="gh", present=True, logged_in=False),
    )
    monkeypatch.setattr(
        setup_discovery,
        "probe_az",
        lambda: setup_discovery.CliToolStatus(name="az", present=True, logged_in=True),
    )

    def _explode() -> list[Any]:
        raise AssertionError("list_gh_hosts must not be called when gh is logged out")

    monkeypatch.setattr(setup_discovery, "list_gh_hosts", _explode)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.get("/api/setup/cli-status")
    assert r.status_code == 200
    assert r.json()["gh_hosts"] == []


# Generic discovery route: `POST /api/setup/providers/{type_id}/discover`.
# Each provider's `setup.discover_step` is the dispatch target; tests patch
# the underlying `provider.<type>.discover` helpers (the I/O layer) so we
# exercise the full route → hooks → discover-helper path.


def test_provider_discover_unknown_type_returns_404(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/does_not_exist/discover",
        headers=SETUP_AUTH,
        json={"stage": "orgs", "payload": {}},
    )
    assert r.status_code == 404


def test_provider_discover_requires_setup_token(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        json={"stage": "orgs", "payload": {}},
    )
    assert r.status_code == 401


def test_azure_devops_discover_orgs_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.azure_devops import discover as ado_discover

    monkeypatch.setattr(
        ado_discover,
        "list_orgs",
        lambda: [
            ado_discover.OrgRef(name="Contoso", url="https://dev.azure.com/contoso"),
        ],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={"stage": "orgs", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["items"] == [
        {"value": "https://dev.azure.com/contoso", "label": "Contoso", "extras": {}}
    ]


def test_azure_devops_discover_projects_requires_org(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={"stage": "projects", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "org" in body["error"]


def test_azure_devops_discover_projects_returns_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.azure_devops import discover as ado_discover

    monkeypatch.setattr(
        ado_discover,
        "list_projects",
        lambda org: [
            ado_discover.ProjectRef(id="acme-id", name="Acme"),
            ado_discover.ProjectRef(id="bravo-id", name="Bravo"),
        ],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={
            "stage": "projects",
            "payload": {"org": "https://dev.azure.com/contoso"},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert [it["value"] for it in body["items"]] == ["Acme", "Bravo"]
    assert [it["label"] for it in body["items"]] == ["Acme", "Bravo"]


def test_azure_devops_discover_teams_requires_project(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={
            "stage": "teams",
            "payload": {"org": "https://dev.azure.com/contoso"},
        },
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "project" in body["error"]


def test_azure_devops_discover_iterations_returns_items(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.azure_devops import discover as ado_discover

    monkeypatch.setattr(
        ado_discover,
        "list_iteration_paths",
        lambda org, project: ["Acme\\Sprint 1", "Acme\\Sprint 2"],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={
            "stage": "iterations",
            "payload": {
                "org": "https://dev.azure.com/contoso",
                "project": "Acme",
            },
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert [it["value"] for it in body["items"]] == ["Acme\\Sprint 1", "Acme\\Sprint 2"]


def test_azure_devops_discover_failure_reports_ok_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Helper raising DiscoveryError → DTO with `ok=false` and the helper's
    message. SPA falls back to free-form entry on this signal."""
    paths = _mk_paths(tmp_path)
    from docket.providers.azure_devops import discover as ado_discover

    def _boom() -> list[Any]:
        raise ado_discover.DiscoveryError("az session expired")

    monkeypatch.setattr(ado_discover, "list_orgs", _boom)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={"stage": "orgs", "payload": {}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "az session expired" in body["error"]


def test_azure_devops_discover_unknown_stage_reports_ok_false(tmp_path: Path) -> None:
    """Unknown stages raise `ValueError` inside the hook; the route maps that
    to `ok=false` so the SPA can fall back gracefully."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/azure_devops/discover",
        headers=SETUP_AUTH,
        json={"stage": "nope", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "nope" in body["error"]


def test_github_discover_repos_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.github import discover as gh_discover

    monkeypatch.setattr(
        gh_discover,
        "list_repos",
        lambda host=None: [
            gh_discover.RepoRef(owner="contoso", name="alpha"),
            gh_discover.RepoRef(owner="contoso", name="bravo"),
        ],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github/discover",
        headers=SETUP_AUTH,
        json={"stage": "repos", "payload": {"host": "github.com"}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert [it["value"] for it in body["items"]] == ["contoso/alpha", "contoso/bravo"]
    assert [it["label"] for it in body["items"]] == ["contoso/alpha", "contoso/bravo"]


def test_github_discover_orgs_ok(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.github import discover as gh_discover

    monkeypatch.setattr(
        gh_discover,
        "list_orgs",
        lambda host=None: [gh_discover.OrgRef(login="contoso")],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github/discover",
        headers=SETUP_AUTH,
        json={"stage": "orgs", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["items"] == [{"value": "contoso", "label": "contoso", "extras": {}}]


def test_github_discover_hosts_includes_api_base_url_in_extras(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`hosts` stage threads `api_base_url` through `extras` so the SPA can
    map a hostname to its API endpoint without a second round-trip."""
    paths = _mk_paths(tmp_path)
    from docket.providers.github import discover as gh_discover

    monkeypatch.setattr(
        gh_discover,
        "list_hosts",
        lambda: [
            gh_discover.HostRef(hostname="github.com", api_base_url="https://api.github.com"),
            gh_discover.HostRef(
                hostname="ghe.example.com", api_base_url="https://ghe.example.com/api/v3"
            ),
        ],
    )
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github/discover",
        headers=SETUP_AUTH,
        json={"stage": "hosts", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["items"][0]["extras"] == {"api_base_url": "https://api.github.com"}
    assert body["items"][1]["extras"] == {"api_base_url": "https://ghe.example.com/api/v3"}


def test_github_discover_org_repos_requires_org(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github/discover",
        headers=SETUP_AUTH,
        json={"stage": "org_repos", "payload": {}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "org" in body["error"]


def test_github_discover_failure_reports_ok_false(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    paths = _mk_paths(tmp_path)
    from docket.providers.github import discover as gh_discover

    def _boom(host: Any = None) -> list[Any]:
        raise gh_discover.DiscoveryError("gh: api rate-limited")

    monkeypatch.setattr(gh_discover, "list_repos", _boom)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github/discover",
        headers=SETUP_AUTH,
        json={"stage": "repos", "payload": {}},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["ok"] is False
    assert "rate-limited" in body["error"]


def test_github_stub_discover_returns_empty_for_known_stages(tmp_path: Path) -> None:
    """github_stub has nothing to scan — known stages return `ok=true,
    items=[]` so the SPA shows the manual-entry fallback rather than a
    discovery error."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/providers/github_stub/discover",
        headers=SETUP_AUTH,
        json={"stage": "repos", "payload": {}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["items"] == []


def test_suggest_key_avoids_taken_slots(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    r = client.post(
        "/api/setup/suggest-key",
        headers=SETUP_AUTH,
        json={"type": "github", "taken": []},
    )
    assert r.status_code == 200
    assert r.json() == {"key": "github"}

    r = client.post(
        "/api/setup/suggest-key",
        headers=SETUP_AUTH,
        json={"type": "github", "taken": ["github"]},
    )
    assert r.json() == {"key": "github-2"}

    r = client.post(
        "/api/setup/suggest-key",
        headers=SETUP_AUTH,
        json={"type": "github", "taken": ["github", "github-2"]},
    )
    assert r.json() == {"key": "github-3"}


def test_suggest_label_for_github(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/suggest-label",
        headers=SETUP_AUTH,
        json={
            "type": "github",
            "config": {"default_repo": "contoso/alpha"},
        },
    )
    assert r.status_code == 200
    # github.com is the implicit default (no `base_url` in config) and folds
    # into the generic "GitHub" prefix.
    assert r.json() == {"label": "GitHub · contoso/alpha"}


def test_suggest_label_for_github_enterprise_host(tmp_path: Path) -> None:
    """A GHE host is identified by the `base_url` in config, not a side hint."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/suggest-label",
        headers=SETUP_AUTH,
        json={
            "type": "github",
            "config": {
                "default_repo": "contoso/alpha",
                "base_url": "https://ghe.contoso.com/api/v3",
            },
        },
    )
    assert r.status_code == 200
    assert r.json() == {"label": "ghe.contoso.com · contoso/alpha"}


def test_suggest_label_for_azure_devops(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/suggest-label",
        headers=SETUP_AUTH,
        json={
            "type": "azure_devops",
            "config": {
                "organization": "https://dev.azure.com/contoso",
                "project": "Acme",
            },
        },
    )
    assert r.status_code == 200
    assert r.json() == {"label": "Azure DevOps · contoso/Acme"}


def test_suggest_label_unknown_type_falls_back_to_id(tmp_path: Path) -> None:
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/suggest-label",
        headers=SETUP_AUTH,
        json={"type": "totally_made_up", "config": {}},
    )
    assert r.json() == {"label": "totally_made_up"}


def test_probe_scope_returns_count_for_stub(tmp_path: Path) -> None:
    """github_stub builds a single demo item — the probe should count 1."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/probe-scope",
        headers=SETUP_AUTH,
        json={
            "type": "github_stub",
            "config": {"default_repo": "contoso/alpha"},
            "scope": {},
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] is not None
    assert body["count"] >= 0
    assert body["error"] == ""


def test_probe_scope_reports_count_none_for_unknown_type(tmp_path: Path) -> None:
    """Unknown provider type → `count=None`, SPA renders 'could not count'."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/probe-scope",
        headers=SETUP_AUTH,
        json={"type": "nope", "config": {}, "scope": {}},
    )
    assert r.status_code == 200
    assert r.json()["count"] is None


def test_probe_scope_reports_invalid_scope(tmp_path: Path) -> None:
    """A scope dict that doesn't validate as ScopeFilter → `count=None` plus
    a hint in `error` so the SPA can flag the field."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    r = client.post(
        "/api/setup/probe-scope",
        headers=SETUP_AUTH,
        json={
            "type": "github_stub",
            "config": {"default_repo": "contoso/alpha"},
            "scope": {"team": 12345},  # team must be a string
        },
    )
    body = r.json()
    assert r.status_code == 200
    assert body["count"] is None
    assert "invalid scope" in body["error"]


# ---- regression: setup-complete scope round-trips into active scope slot ----


def test_setup_complete_scope_round_trips_into_default_slot(tmp_path: Path) -> None:
    """Bootstrap-mode `/setup/complete` with a non-empty scope must persist
    the values into `providers[key].scopes['default']` (no other slot exists
    on first run). Regression for: web-wizard scopes silently dropped when
    the bootstrap path took a different code path than the live one."""
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))
    payload: dict[str, Any] = {
        "providers": {
            "demo": {
                "type": "github_stub",
                "display_name": "Demo",
                "config": {"default_repo": "contoso/alpha"},
                "scope": {"assignee": "@me", "team": "Team Z"},
            }
        },
        "active_provider": "demo",
        "llm": None,
        "http_token": "operator-token",
        "run_initial_sync": False,
    }
    r = client.post("/api/setup/complete", headers=SETUP_AUTH, json=payload)
    assert r.status_code == 200, r.text

    with paths.config_file.open("rb") as f:
        raw = tomllib.load(f)
    entry = raw["providers"]["demo"]
    assert entry["active_scope"] == "default"
    assert entry["scopes"]["default"]["assignee"] == "@me"
    assert entry["scopes"]["default"]["team"] == "Team Z"


# ---- bootstrap SPA: setup wizard is reachable from the same origin --------


def test_bootstrap_spa_root_renders_with_setup_token_injected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When `config.toml` doesn't exist, the bootstrap app's SPA mount must
    serve `index.html` at `/` with the setup token injected as
    `window.__DOCKET_TOKEN__` so the browser-side wizard can authenticate
    against `/api/setup/*` without the operator copy-pasting a token."""
    dist = tmp_path / "fake-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text(
        "<!doctype html><html><head><title>Docket</title></head>"
        "<body><div id=root></div></body></html>",
        encoding="utf-8",
    )
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(dist))

    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    res = client.get("/")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    body = res.text
    assert "<div id=root>" in body
    assert "window.__DOCKET_TOKEN__" in body
    assert f'"{SETUP_TOKEN}"' in body


def test_bootstrap_spa_status_endpoint_remains_unauthenticated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Even with a SPA mounted, `/api/setup/status` stays auth-free — the
    wizard polls it before it has any token to send."""
    dist = tmp_path / "fake-dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html><head></head><body/></html>", encoding="utf-8")
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(dist))

    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    res = client.get("/api/setup/status")
    assert res.status_code == 200
    assert res.json()["needs_setup"] is True


def test_bootstrap_spa_deep_link_returns_index_html(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deep-linking to a SPA route (e.g. `/wizard`) on the bootstrap app
    must return `index.html`, not 404 — the React router resolves the
    in-page route after the bundle loads."""
    dist = tmp_path / "fake-dist"
    dist.mkdir()
    (dist / "index.html").write_text(
        "<!doctype html><html><head></head><body><div id=root></div></body></html>",
        encoding="utf-8",
    )
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(dist))

    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    res = client.get("/wizard/llm")
    assert res.status_code == 200
    assert "<div id=root>" in res.text


def test_bootstrap_spa_missing_bundle_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the bundle isn't built yet, the bootstrap app still serves a
    friendly fallback page at `/` (so newly-cloned repos don't 404)."""
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(tmp_path / "missing"))
    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    res = client.get("/")
    assert res.status_code == 200
    assert "frontend bundle not built" in res.text.lower()


def test_bootstrap_spa_does_not_shadow_setup_routes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The SPA's catch-all must not intercept `/api/setup/*` — a SPA mount
    that swallowed the API routes would brick the wizard."""
    dist = tmp_path / "fake-dist"
    dist.mkdir()
    (dist / "index.html").write_text("<html/>", encoding="utf-8")
    monkeypatch.setenv("DOCKET_FRONTEND_DIST", str(dist))

    paths = _mk_paths(tmp_path)
    client = TestClient(create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN))

    # Authenticated → JSON, not HTML.
    res = client.get("/api/setup/providers/types", headers=SETUP_AUTH)
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
