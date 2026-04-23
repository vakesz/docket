"""HTTP coverage for the runtime/admin endpoints:

- pins (GET/POST/DELETE /items/{id}/pin, GET /pinned)
- suggestions (POST /items/{id}/suggestion, /stage)
- prompts (GET/PUT/DELETE /prompts/{key})
- settings (GET/PATCH /settings)
- scopes (GET, PUT /scopes/active)
- providers (GET, PUT /providers/active)
- sync (POST /sync)
- status (GET /status)

Shared fixtures build a config with two providers + two scopes so switch
endpoints have something non-trivial to flip between."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.api import create_app
from docket.api.runtime import RuntimeState
from docket.config.models import (
    Config,
    HttpConfig,
    ProviderEntry,
    ScopeFilter,
)
from docket.config.paths import Paths
from docket.core.model import Item, ItemKind, ItemState
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.fakes.llm import FakeLlmClient, text_turn
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def _mk_item(id_: str = "S-1", title: str = "Login", provider_key: str = "primary") -> Item:
    return Item(
        id=id_,
        kind=ItemKind.STORY,
        title=title,
        description_md="Add login.",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
        provider_key=provider_key,
    )


def _mk_paths(tmp_path: Path) -> Paths:
    config_dir = tmp_path / "config"
    state_dir = tmp_path / "state"
    cache_dir = tmp_path / "cache"
    paths = Paths(config_dir=config_dir, state_dir=state_dir, cache_dir=cache_dir)
    paths.ensure()
    return paths


def _mk_config() -> Config:
    return Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/primary"},
                scopes={
                    "default": ScopeFilter(assignee="@me"),
                    "team": ScopeFilter(team="core", assignee="@me"),
                },
                active_scope="default",
            ),
            "secondary": ProviderEntry(
                type="github_stub",
                display_name="Secondary",
                config={"default_repo": "example/secondary"},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            ),
        },
        active_provider="primary",
        http=HttpConfig(enabled=True, token=TOKEN),
    )


@pytest.fixture
def env(tmp_path: Path):
    conn = init_db(tmp_path / "state" / "docket.db") if False else None
    # init_db requires the parent dir to exist; build via paths.ensure below
    paths = _mk_paths(tmp_path)
    conn = init_db(paths.db_file)
    item = _mk_item()
    item_repo.upsert_item(conn, item)
    provider_primary = FakeProvider(items=[item])
    provider_secondary = FakeProvider()
    providers = {"primary": provider_primary, "secondary": provider_secondary}
    config = _mk_config()
    runtime = RuntimeState(
        config=config,
        providers=providers,
        provider_key="primary",
        scope_key="default",
    )
    proposals = ProposalStore()
    yield {
        "conn": conn,
        "paths": paths,
        "runtime": runtime,
        "providers": providers,
        "proposals": proposals,
        "item": item,
    }
    conn.close()


@pytest.fixture
def client(env) -> TestClient:
    app = create_app(
        conn=env["conn"],
        provider=env["runtime"].provider,
        bearer_token=TOKEN,
        proposals=env["proposals"],
        paths=env["paths"],
        runtime=env["runtime"],
    )
    return TestClient(app)


@pytest.fixture
def ro_client(env) -> TestClient:
    app = create_app(
        conn=env["conn"],
        provider=env["runtime"].provider,
        bearer_token=TOKEN,
        proposals=env["proposals"],
        paths=env["paths"],
        runtime=env["runtime"],
        read_only=True,
    )
    return TestClient(app)


# -- pins --------------------------------------------------------------------


def test_pin_then_list_pinned(client: TestClient) -> None:
    r = client.post("/items/S-1/pin", headers=AUTH)
    assert r.status_code == 204
    status_resp = client.get("/items/S-1/pinned", headers=AUTH)
    assert status_resp.json() == {"item_id": "S-1", "pinned": True}
    listed = client.get("/pinned", headers=AUTH)
    assert listed.status_code == 200
    body = listed.json()
    assert len(body) == 1 and body[0]["id"] == "S-1"


def test_unpin_is_idempotent(client: TestClient) -> None:
    client.post("/items/S-1/pin", headers=AUTH)
    r1 = client.delete("/items/S-1/pin", headers=AUTH)
    r2 = client.delete("/items/S-1/pin", headers=AUTH)
    assert r1.status_code == 204
    assert r2.status_code == 204
    assert client.get("/items/S-1/pinned", headers=AUTH).json()["pinned"] is False


def test_pin_read_only_returns_403(ro_client: TestClient) -> None:
    assert ro_client.post("/items/S-1/pin", headers=AUTH).status_code == 403
    assert ro_client.delete("/items/S-1/pin", headers=AUTH).status_code == 403
    # reads still work
    assert ro_client.get("/items/S-1/pinned", headers=AUTH).status_code == 200


def test_pinned_status_unknown_item_404(client: TestClient) -> None:
    assert client.get("/items/unknown/pinned", headers=AUTH).status_code == 404


# -- suggestions -------------------------------------------------------------


def _suggestion_payload() -> str:
    return json.dumps(
        {
            "intent": "start_work",
            "description_patch_md": "Better description.",
            "open_questions": ["anything unclear?"],
        }
    )


def test_suggestion_happy_path(env) -> None:
    llm = FakeLlmClient(script=[text_turn(_suggestion_payload())])
    app = create_app(
        conn=env["conn"],
        provider=env["runtime"].provider,
        bearer_token=TOKEN,
        proposals=env["proposals"],
        paths=env["paths"],
        runtime=env["runtime"],
        llm=llm,
    )
    client = TestClient(app)
    r = client.post("/items/S-1/suggestion", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["intent"] == "start_work"
    assert body["description_patch_md"] == "Better description."
    assert body["open_questions"] == ["anything unclear?"]


def test_suggestion_without_llm_is_503(client: TestClient) -> None:
    r = client.post("/items/S-1/suggestion", headers=AUTH)
    assert r.status_code == 503


def test_stage_suggestion_adds_proposals(client: TestClient, env) -> None:
    r = client.post(
        "/items/S-1/suggestion/stage",
        headers=AUTH,
        json={"intent": "start_work", "description_patch_md": "New body"},
    )
    assert r.status_code == 200
    proposals = r.json()
    kinds = {p["kind"] for p in proposals}
    assert kinds == {"state_change", "description_patch"}
    # Both are in the store now.
    assert len(env["proposals"]) == 2


def test_stage_suggestion_no_patch_only_state_change(client: TestClient, env) -> None:
    r = client.post(
        "/items/S-1/suggestion/stage",
        headers=AUTH,
        json={"intent": "pause", "description_patch_md": ""},
    )
    body = r.json()
    assert len(body) == 1 and body[0]["kind"] == "state_change"


def test_stage_suggestion_read_only_403(ro_client: TestClient) -> None:
    r = ro_client.post(
        "/items/S-1/suggestion/stage",
        headers=AUTH,
        json={"intent": "start_work"},
    )
    assert r.status_code == 403


# -- prompts -----------------------------------------------------------------


def test_list_prompts_default_uncustomized(client: TestClient) -> None:
    r = client.get("/prompts", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    keys = {p["key"] for p in body}
    assert "system_base" in keys
    assert {p["customized"] for p in body} == {False}


def test_put_prompt_writes_and_marks_customized(client: TestClient, env) -> None:
    r = client.put(
        "/prompts/system_base",
        headers=AUTH,
        json={"content_md": "custom system prompt"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["customized"] is True
    assert body["content_md"] == "custom system prompt"
    on_disk = (env["paths"].prompts_dir / "system_base.md").read_text(encoding="utf-8")
    assert on_disk == "custom system prompt"


def test_delete_prompt_restores_default_content(client: TestClient, env) -> None:
    client.put(
        "/prompts/system_base",
        headers=AUTH,
        json={"content_md": "custom"},
    )
    r = client.delete("/prompts/system_base", headers=AUTH)
    assert r.status_code == 200
    # Returned content is the canonical default
    default = r.json()["content_md"]
    assert "work-item triage assistant" in default


def test_prompt_unknown_key_404(client: TestClient) -> None:
    assert client.get("/prompts/nonsense", headers=AUTH).status_code == 404
    r = client.put("/prompts/nonsense", headers=AUTH, json={"content_md": "x"})
    assert r.status_code == 404


def test_prompt_put_read_only_403(ro_client: TestClient) -> None:
    r = ro_client.put("/prompts/system_base", headers=AUTH, json={"content_md": "x"})
    assert r.status_code == 403


# -- settings ----------------------------------------------------------------


def test_get_settings_masks_token(client: TestClient) -> None:
    r = client.get("/settings", headers=AUTH)
    assert r.status_code == 200
    cfg = r.json()["config"]
    masked = cfg["http"]["token"]
    assert masked.startswith("••••••••")
    assert TOKEN not in masked


def test_patch_settings_deep_merges_and_persists(client: TestClient, env) -> None:
    r = client.patch(
        "/settings",
        headers=AUTH,
        json={"patch": {"ui": {"default_new_item_kind": "bug"}}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["config"]["ui"]["default_new_item_kind"] == "bug"
    # File on disk is updated
    assert env["paths"].config_file.exists()
    # Runtime is updated in memory
    assert env["runtime"].config.ui.default_new_item_kind == "bug"


def test_patch_settings_masked_token_is_ignored(client: TestClient, env) -> None:
    # Client echoes the masked token; we must not persist it as the real token
    r = client.patch(
        "/settings",
        headers=AUTH,
        json={"patch": {"http": {"token": "••••••••fake", "port": 9000}}},
    )
    assert r.status_code == 200
    assert env["runtime"].config.http.token == TOKEN  # unchanged
    assert env["runtime"].config.http.port == 9000


def test_patch_settings_requires_restart_flags(client: TestClient) -> None:
    r = client.patch(
        "/settings",
        headers=AUTH,
        json={"patch": {"http": {"port": 9999}}},
    )
    assert "http" in r.json()["requires_restart"]


def test_patch_settings_validation_error_422(client: TestClient) -> None:
    r = client.patch(
        "/settings",
        headers=AUTH,
        json={"patch": {"ui": {"default_new_item_kind": "nonsense"}}},
    )
    assert r.status_code == 422


def test_patch_settings_read_only_403(ro_client: TestClient) -> None:
    r = ro_client.patch(
        "/settings", headers=AUTH, json={"patch": {"ui": {"default_new_item_kind": "bug"}}}
    )
    assert r.status_code == 403


# -- scopes ------------------------------------------------------------------


def test_list_scopes_marks_active(client: TestClient) -> None:
    r = client.get("/scopes", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    actives = [s for s in body if s["active"]]
    assert len(actives) == 1 and actives[0]["name"] == "default"


def test_switch_scope_updates_runtime(client: TestClient, env) -> None:
    r = client.put("/scopes/active", headers=AUTH, json={"name": "team"})
    assert r.status_code == 200
    assert env["runtime"].scope_key == "team"
    active_provider = client.get("/providers/active", headers=AUTH)
    assert active_provider.status_code == 200
    assert active_provider.json()["active_scope"] == "team"
    listed = client.get("/providers", headers=AUTH)
    assert listed.status_code == 200
    by_key = {row["key"]: row for row in listed.json()}
    assert by_key["primary"]["active_scope"] == "team"
    assert by_key["secondary"]["active_scope"] == "default"


def test_switch_scope_unknown_returns_404(client: TestClient) -> None:
    r = client.put("/scopes/active", headers=AUTH, json={"name": "ghost"})
    assert r.status_code == 404


def test_scope_switch_read_only_403(ro_client: TestClient) -> None:
    r = ro_client.put("/scopes/active", headers=AUTH, json={"name": "team"})
    assert r.status_code == 403


# -- providers ---------------------------------------------------------------


def test_list_providers(client: TestClient) -> None:
    r = client.get("/providers", headers=AUTH)
    body = r.json()
    keys = {p["key"] for p in body}
    assert keys == {"primary", "secondary"}
    actives = [p for p in body if p["active"]]
    assert len(actives) == 1 and actives[0]["key"] == "primary"


def test_switch_provider_resets_scope(client: TestClient, env) -> None:
    # primary is on scope 'default'; move it to 'team' then switch providers
    client.put("/scopes/active", headers=AUTH, json={"name": "team"})
    r = client.put("/providers/active", headers=AUTH, json={"key": "secondary"})
    assert r.status_code == 200
    assert env["runtime"].provider_key == "secondary"
    assert env["runtime"].scope_key == "default"  # reset to secondary's active_scope


def test_switch_provider_unknown_404(client: TestClient) -> None:
    r = client.put("/providers/active", headers=AUTH, json={"key": "ghost"})
    assert r.status_code == 404


# -- sync --------------------------------------------------------------------


def test_manual_sync_returns_summary(client: TestClient, env) -> None:
    r = client.post("/sync", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert "upserted" in body
    assert env["runtime"].last_sync_at is not None
    assert env["runtime"].offline is False


def test_manual_sync_read_only_403(ro_client: TestClient) -> None:
    r = ro_client.post("/sync", headers=AUTH)
    assert r.status_code == 403


def test_manual_sync_provider_error_502_and_offline(client: TestClient, env) -> None:
    def boom(*a: object, **k: object) -> list[Item]:
        raise RuntimeError("provider down")

    env["providers"]["primary"].list_changes_since = boom  # type: ignore[assignment]
    r = client.post("/sync", headers=AUTH)
    assert r.status_code == 502
    assert env["runtime"].offline is True


# -- status ------------------------------------------------------------------


def test_status_snapshot(client: TestClient, env) -> None:
    r = client.get("/status", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["provider_key"] == "primary"
    assert body["provider_display"] == "Primary"
    assert body["scope_key"] == "default"
    assert body["read_only"] is False
    assert body["chat_enabled"] is False
    assert body["pending_proposals"] == 0


def test_status_chat_enabled_follows_llm(env) -> None:
    llm = FakeLlmClient()
    app = create_app(
        conn=env["conn"],
        provider=env["runtime"].provider,
        bearer_token=TOKEN,
        proposals=env["proposals"],
        paths=env["paths"],
        runtime=env["runtime"],
        llm=llm,
    )
    client = TestClient(app)
    r = client.get("/status", headers=AUTH)
    assert r.json()["chat_enabled"] is True


def test_status_read_only_flag(ro_client: TestClient) -> None:
    r = ro_client.get("/status", headers=AUTH)
    assert r.json()["read_only"] is True
