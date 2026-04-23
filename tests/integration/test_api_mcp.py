"""HTTP smoke tests for /projects/{id}/mcp routes."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from docket.agent.mcp import MCPManager
from docket.api import create_app
from docket.api.runtime import RuntimeState
from docket.config import (
    Config,
    MCPServerEntry,
    ProjectEntry,
    ProviderEntry,
    ScopeFilter,
    save_config,
)
from docket.config.paths import resolve_paths
from docket.core.model import project_id_for
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def _pid() -> str:
    return project_id_for("main")


@pytest.fixture
def client(tmp_xdg: Path) -> Iterator[TestClient]:
    paths = resolve_paths()
    paths.ensure()
    conn = init_db(paths.db_file)
    pid = _pid()
    config = Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="main",
        projects={
            pid: ProjectEntry(
                provider_key="main",
                name="Main",
            )
        },
        http={"enabled": True, "bind": "127.0.0.1", "port": 8765, "token": TOKEN},
    )
    save_config(paths, config)
    provider = FakeProvider()
    runtime = RuntimeState(
        config=config,
        providers={"main": provider},
        provider_key="main",
        scope_key="default",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token=TOKEN,
        proposals=ProposalStore(),
        paths=paths,
        runtime=runtime,
        config=config,
    )
    try:
        with TestClient(app) as test_client:
            # `with` activates the lifespan handler so MCP subprocesses are
            # torn down on fixture teardown. Without it, `_lifespan` is
            # never entered and any started clients leak.
            yield test_client
    finally:
        conn.close()


def _manager(client: TestClient) -> MCPManager:
    """Pull the live MCP manager out of the app the test client wraps."""
    mgr = client.app.state.mcp_manager
    assert isinstance(mgr, MCPManager), "test fixture should have wired a manager"
    return mgr


def _server_payload(*, name: str = "fake", enabled: bool = True) -> dict[str, object]:
    return {
        "name": name,
        "command": sys.executable,
        "args": ["-m", "tests.fakes.mcp_server"],
        "env": {},
        "transport": "stdio",
        "enabled": enabled,
        "startup_timeout_seconds": 15.0,
    }


def test_list_when_empty(client: TestClient) -> None:
    pid = _pid()
    resp = client.get(f"/projects/{pid}/mcp", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["project_id"] == pid
    assert body["entries"] == []


def test_create_then_get_round_trips(client: TestClient) -> None:
    pid = _pid()
    resp = client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "fake"
    assert body["command"] == sys.executable
    assert body["args"] == ["-m", "tests.fakes.mcp_server"]

    one = client.get(f"/projects/{pid}/mcp/fake", headers=AUTH_HEADERS)
    assert one.status_code == 200
    assert one.json()["startup_timeout_seconds"] == 15.0


def test_create_duplicate_is_409(client: TestClient) -> None:
    pid = _pid()
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    again = client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert again.status_code == 409


def test_patch_updates_specific_fields(client: TestClient) -> None:
    pid = _pid()
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    resp = client.patch(
        f"/projects/{pid}/mcp/fake",
        json={"enabled": False, "startup_timeout_seconds": 7.0},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["enabled"] is False
    assert body["startup_timeout_seconds"] == 7.0
    # Untouched fields preserved.
    assert body["command"] == sys.executable


def test_patch_requires_at_least_one_field(client: TestClient) -> None:
    pid = _pid()
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    resp = client.patch(f"/projects/{pid}/mcp/fake", json={}, headers=AUTH_HEADERS)
    assert resp.status_code == 400


def test_delete_removes_entry(client: TestClient) -> None:
    pid = _pid()
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    resp = client.delete(f"/projects/{pid}/mcp/fake", headers=AUTH_HEADERS)
    assert resp.status_code == 204
    assert client.get(f"/projects/{pid}/mcp/fake", headers=AUTH_HEADERS).status_code == 404


def test_test_endpoint_starts_real_server(client: TestClient) -> None:
    pid = _pid()
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    resp = client.post(f"/projects/{pid}/mcp/fake/test", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "mcp__fake__echo" in body["tools"]
    assert any(tool["name"] == "echo" for tool in body["tool_details"])
    echo_tool = next(tool for tool in body["tool_details"] if tool["name"] == "echo")
    assert echo_tool["description"]
    assert echo_tool["input_schema"]["type"] == "object"


def test_draft_test_endpoint_validates_without_persisting(client: TestClient) -> None:
    pid = _pid()
    resp = client.post(
        f"/projects/{pid}/mcp/test",
        json=_server_payload(name="draft"),
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert "mcp__draft__echo" in body["tools"]
    listed = client.get(f"/projects/{pid}/mcp", headers=AUTH_HEADERS)
    assert listed.json()["entries"] == []


def test_test_endpoint_reports_failure_for_broken_command(client: TestClient) -> None:
    pid = _pid()
    payload = {
        "name": "broken",
        "command": sys.executable,
        "args": ["-c", "import sys; sys.exit(1)"],
        "env": {},
        "transport": "stdio",
        "enabled": True,
        "startup_timeout_seconds": 2.0,
    }
    client.post(f"/projects/{pid}/mcp", json=payload, headers=AUTH_HEADERS)
    resp = client.post(f"/projects/{pid}/mcp/broken/test", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert body["error"]


def test_draft_test_endpoint_reports_invalid_transport(client: TestClient) -> None:
    pid = _pid()
    payload = _server_payload(name="draft")
    payload["transport"] = "sse"
    resp = client.post(f"/projects/{pid}/mcp/test", json=payload, headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert "Only 'stdio' is supported" in body["error"]


def test_unknown_project_returns_404(client: TestClient) -> None:
    resp = client.get("/projects/ghost/mcp", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_unknown_server_returns_404(client: TestClient) -> None:
    pid = _pid()
    resp = client.get(f"/projects/{pid}/mcp/ghost", headers=AUTH_HEADERS)
    assert resp.status_code == 404


def test_routes_require_auth(client: TestClient) -> None:
    pid = _pid()
    assert client.get(f"/projects/{pid}/mcp").status_code == 401
    assert client.post(f"/projects/{pid}/mcp/test", json=_server_payload()).status_code == 401


def test_create_rebinds_active_runtime_manager(client: TestClient) -> None:
    """Persisting an MCP server for the active project rebinds the live fleet."""
    pid = _pid()
    manager = _manager(client)
    assert manager.clients == {}
    resp = client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 201, resp.text
    assert "fake" in manager.clients
    assert manager.active_project_id == pid


def test_create_rejects_unsupported_transport(client: TestClient) -> None:
    pid = _pid()
    payload = _server_payload()
    payload["transport"] = "sse"
    resp = client.post(f"/projects/{pid}/mcp", json=payload, headers=AUTH_HEADERS)
    assert resp.status_code == 400
    assert "Only 'stdio' is supported" in resp.text


def test_disable_via_patch_drops_running_client(client: TestClient) -> None:
    pid = _pid()
    manager = _manager(client)
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert "fake" in manager.clients
    resp = client.patch(f"/projects/{pid}/mcp/fake", json={"enabled": False}, headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    assert manager.clients == {}


def test_delete_drops_running_client(client: TestClient) -> None:
    pid = _pid()
    manager = _manager(client)
    client.post(f"/projects/{pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert "fake" in manager.clients
    resp = client.delete(f"/projects/{pid}/mcp/fake", headers=AUTH_HEADERS)
    assert resp.status_code == 204
    assert manager.clients == {}


def test_inactive_project_writes_persist_but_do_not_rebind(
    client: TestClient, tmp_xdg: Path
) -> None:
    """Targeting a non-active project still writes config but does not touch the live fleet."""
    paths = resolve_paths()
    cfg = client.app.state.config
    cfg.providers["secondary"] = ProviderEntry(
        type="github_stub",
        display_name="Secondary",
        config={},
        scopes={"default": ScopeFilter()},
        active_scope="default",
    )
    other_pid = project_id_for("secondary")
    cfg.projects[other_pid] = ProjectEntry(provider_key="secondary", name="Other")
    save_config(paths, cfg)

    manager = _manager(client)
    resp = client.post(f"/projects/{other_pid}/mcp", json=_server_payload(), headers=AUTH_HEADERS)
    assert resp.status_code == 201, resp.text
    # Active project hasn't changed → live manager unchanged.
    assert manager.clients == {}
    # Confirmed the entry actually persisted on the targeted (inactive) project.
    listed = client.get(f"/projects/{other_pid}/mcp", headers=AUTH_HEADERS)
    assert [e["name"] for e in listed.json()["entries"]] == ["fake"]


def test_get_does_not_require_runtime(client: TestClient) -> None:
    """Read endpoints work even when no MCP servers are configured."""
    pid = _pid()
    # Create the server entry directly via the config-only helper to avoid
    # the runtime side effect, then read it back over HTTP.
    cfg = client.app.state.config
    cfg.projects[pid].mcp["plain"] = MCPServerEntry(command="/bin/true")
    save_config(resolve_paths(), cfg)
    resp = client.get(f"/projects/{pid}/mcp/plain", headers=AUTH_HEADERS)
    assert resp.status_code == 200
    assert resp.json()["command"] == "/bin/true"


def test_list_presets_includes_github(client: TestClient) -> None:
    resp = client.get("/mcp/presets", headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    ids = [p["id"] for p in body["presets"]]
    assert "github" in ids
    github = next(p for p in body["presets"] if p["id"] == "github")
    assert github["command"] == "npx"
    assert github["args"] == ["-y", "@modelcontextprotocol/server-github"]
    env_names = [v["name"] for v in github["env"]]
    assert "GITHUB_PERSONAL_ACCESS_TOKEN" in env_names


def test_apply_preset_github_creates_server_and_rebinds(client: TestClient) -> None:
    pid = _pid()
    manager = _manager(client)
    resp = client.post(
        f"/projects/{pid}/mcp/presets/github/apply",
        json={"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"}},
        headers=AUTH_HEADERS,
    )
    # The preset command (`npx`) may or may not be installed, so the rebind
    # either succeeds or fails soft with an empty client set — either way the
    # persistence side must have worked.
    assert resp.status_code == 201, resp.text
    assert resp.json()["name"] == "github"
    listed = client.get(f"/projects/{pid}/mcp", headers=AUTH_HEADERS).json()
    assert [e["name"] for e in listed["entries"]] == ["github"]
    # `active_project_id` flips regardless of whether the client started.
    assert manager.active_project_id == pid


def test_apply_preset_rejects_missing_env(client: TestClient) -> None:
    pid = _pid()
    resp = client.post(
        f"/projects/{pid}/mcp/presets/github/apply",
        json={"env": {}},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 400
    assert "GITHUB_PERSONAL_ACCESS_TOKEN" in resp.text


def test_apply_preset_unknown_id_is_404(client: TestClient) -> None:
    pid = _pid()
    resp = client.post(
        f"/projects/{pid}/mcp/presets/nonexistent/apply",
        json={"env": {"FOO": "bar"}},
        headers=AUTH_HEADERS,
    )
    assert resp.status_code == 404


def test_apply_preset_requires_auth(client: TestClient) -> None:
    pid = _pid()
    resp = client.post(
        f"/projects/{pid}/mcp/presets/github/apply",
        json={"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_fake"}},
    )
    assert resp.status_code == 401
