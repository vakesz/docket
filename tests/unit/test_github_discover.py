"""Unit tests for the GitHub discovery helpers.

These stub `subprocess.run` because the helpers shell out to `gh`. We're
testing the wrapper's parsing and error surface, not `gh` itself."""

from __future__ import annotations

import json
import subprocess
from typing import Any

import pytest

from docket.providers.github import discover


def _fake_run_factory(responses: dict[tuple[str, ...], tuple[str, int]]):
    """Return a fake subprocess.run that looks up canned responses by argv.

    Key is the tuple form of the command after the binary path (so we don't
    pin to `gh`'s absolute path). Value is (stdout, returncode)."""

    def _fake(cmd: list[str], *_args: Any, **_kwargs: Any) -> subprocess.CompletedProcess:
        argv = tuple(cmd[1:])
        if argv not in responses:
            raise AssertionError(f"unexpected gh call: {argv}")
        stdout, rc = responses[argv]
        if rc != 0:
            raise subprocess.CalledProcessError(rc, cmd, stdout, stderr="")
        return subprocess.CompletedProcess(cmd, rc, stdout=stdout, stderr="")

    return _fake


def test_list_orgs_parses_login(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"login": "anthropics"}, {"login": "openai"}, {"not_a_login": 1}])
    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_run_factory({("api", "--method", "GET", "/user/orgs", "--paginate"): (body, 0)}),
    )
    orgs = discover.list_orgs()
    assert [o.login for o in orgs] == ["anthropics", "openai"]


def test_list_repos_for_authed_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps(
        [
            {"full_name": "acme/widgets"},
            {"full_name": "acme/dotfiles"},
            {"not_full": True},
        ]
    )
    argv = (
        "api",
        "--method",
        "GET",
        "/user/repos",
        "-f",
        "per_page=50",
        "-f",
        "sort=updated",
    )
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_repos()
    assert [r.full_name for r in repos] == ["acme/widgets", "acme/dotfiles"]


def test_list_repos_for_user_uses_users_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """`/users/{login}/repos` is the right endpoint for a plain user — it returns
    only public repos, which is fine for a user lookup."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"full_name": "anthropics/claude-code"}])
    argv = (
        "api",
        "--method",
        "GET",
        "/users/anthropics/repos",
        "-f",
        "per_page=50",
        "-f",
        "sort=updated",
    )
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_repos(owner="anthropics")
    assert [r.full_name for r in repos] == ["anthropics/claude-code"]


def test_list_org_repos_uses_orgs_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: `/orgs/{login}/repos` returns private repos the caller can
    access; `/users/{login}/repos` would only give public ones."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps(
        [
            {"full_name": "anthropics/secret-project"},
            {"full_name": "anthropics/claude-code"},
        ]
    )
    argv = (
        "api",
        "--method",
        "GET",
        "/orgs/anthropics/repos",
        "-f",
        "per_page=100",
        "-f",
        "sort=updated",
    )
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_org_repos("anthropics")
    assert [r.full_name for r in repos] == [
        "anthropics/secret-project",
        "anthropics/claude-code",
    ]


def test_list_labels_parses_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"name": "bug"}, {"name": "enhancement"}, {"wrong": 1}])
    argv = ("api", "--method", "GET", "/repos/x/y/labels", "--paginate")
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    assert discover.list_labels("x/y") == ["bug", "enhancement"]


def test_list_labels_rejects_non_repo_form(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    with pytest.raises(discover.DiscoveryError):
        discover.list_labels("bare")


def test_gh_api_failure_becomes_discovery_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_run_factory(
            {
                ("api", "--method", "GET", "/user/orgs", "--paginate"): (
                    '{"message":"Bad creds"}',
                    1,
                )
            }
        ),
    )
    with pytest.raises(discover.DiscoveryError):
        discover.list_orgs()


def test_gh_api_non_json_becomes_discovery_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    argv = (
        "api",
        "--method",
        "GET",
        "/user/repos",
        "-f",
        "per_page=50",
        "-f",
        "sort=updated",
    )
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: ("not json at all", 0)}))
    with pytest.raises(discover.DiscoveryError):
        discover.list_repos()


def test_gh_api_forces_get_method_even_with_params(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression for the silent POST-inference bug: `gh api /user/repos -f k=v`
    used to switch to POST (= "create repo"), so every discovery call came
    back as HTTP 422. Every invocation must now pass `--method GET`."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    seen: list[list[str]] = []

    def _capture(cmd: list[str], *_a: Any, **_kw: Any) -> subprocess.CompletedProcess:
        seen.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="[]", stderr="")

    monkeypatch.setattr(subprocess, "run", _capture)
    discover.list_repos()
    discover.list_orgs()
    discover.list_labels("x/y")
    for cmd in seen:
        assert "--method" in cmd and cmd[cmd.index("--method") + 1] == "GET"


def test_list_repos_targets_specific_host(monkeypatch: pytest.MonkeyPatch) -> None:
    """Multi-host support: `host=` must route through `gh api --hostname <host>`
    so the wizard can query github.com AND an enterprise host side-by-side."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"full_name": "acme/widgets"}])
    argv = (
        "api",
        "--method",
        "GET",
        "/user/repos",
        "-f",
        "per_page=50",
        "-f",
        "sort=updated",
        "--hostname",
        "ghe.example.com",
    )
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_repos(host="ghe.example.com")
    assert [r.full_name for r in repos] == ["acme/widgets"]


def test_list_hosts_parses_gh_auth_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """`gh auth status --json hosts` returns `{"hosts": {"<host>": {...}}}`.
    Enterprise hosts map to `/api/v3`; github.com maps to api.github.com."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    payload = json.dumps(
        {
            "hosts": {
                "github.com": {"active_user": "someone"},
                "ghe.example.com": {"active_user": "someone"},
            }
        }
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        _fake_run_factory({("auth", "status", "--json", "hosts"): (payload, 0)}),
    )
    hosts = discover.list_hosts()
    by_name = {h.hostname: h.api_base_url for h in hosts}
    assert by_name == {
        "github.com": "https://api.github.com",
        "ghe.example.com": "https://ghe.example.com/api/v3",
    }


def test_list_hosts_returns_empty_on_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """`list_hosts()` is called in the UX path — it must swallow failures so the
    wizard transparently falls back to single-host mode."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")

    def _fail(*_a: Any, **_kw: Any) -> subprocess.CompletedProcess:
        raise subprocess.CalledProcessError(1, ["gh", "auth", "status"], "", "not logged in")

    monkeypatch.setattr(subprocess, "run", _fail)
    assert discover.list_hosts() == []
