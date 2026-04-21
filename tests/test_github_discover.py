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
        _fake_run_factory({("api", "/user/orgs", "--paginate"): (body, 0)}),
    )
    orgs = discover.list_orgs()
    assert [o.login for o in orgs] == ["anthropics", "openai"]


def test_list_repos_for_authed_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps(
        [
            {"full_name": "vakesz/docket"},
            {"full_name": "vakesz/dotfiles"},
            {"not_full": True},
        ]
    )
    argv = ("api", "/user/repos", "-f", "per_page=50", "-f", "sort=updated")
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_repos()
    assert [r.full_name for r in repos] == ["vakesz/docket", "vakesz/dotfiles"]


def test_list_repos_for_user_uses_users_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """`/users/{login}/repos` is the right endpoint for a plain user — it returns
    only public repos, which is fine for a user lookup."""
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"full_name": "anthropics/claude-code"}])
    argv = ("api", "/users/anthropics/repos", "-f", "per_page=50", "-f", "sort=updated")
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
    argv = ("api", "/orgs/anthropics/repos", "-f", "per_page=100", "-f", "sort=updated")
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: (body, 0)}))
    repos = discover.list_org_repos("anthropics")
    assert [r.full_name for r in repos] == [
        "anthropics/secret-project",
        "anthropics/claude-code",
    ]


def test_list_labels_parses_names(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    body = json.dumps([{"name": "bug"}, {"name": "enhancement"}, {"wrong": 1}])
    argv = ("api", "/repos/x/y/labels", "--paginate")
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
        _fake_run_factory({("api", "/user/orgs", "--paginate"): ("{\"message\":\"Bad creds\"}", 1)}),
    )
    with pytest.raises(discover.DiscoveryError):
        discover.list_orgs()


def test_gh_api_non_json_becomes_discovery_error(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(discover, "_gh_path", lambda: "/usr/bin/gh")
    argv = ("api", "/user/repos", "-f", "per_page=50", "-f", "sort=updated")
    monkeypatch.setattr(subprocess, "run", _fake_run_factory({argv: ("not json at all", 0)}))
    with pytest.raises(discover.DiscoveryError):
        discover.list_repos()
