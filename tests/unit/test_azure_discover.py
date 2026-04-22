"""Unit tests for the Azure DevOps discovery module.

The module only talks to Azure DevOps via `requests`, so we stub the HTTP boundary
rather than hitting the network. A custom fake session lets each test script
exactly which URL returns which payload, including error paths."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import pytest
import requests

from docket.providers.azure_devops import discover
from docket.providers.azure_devops.discover import (
    DiscoveryError,
    OrgRef,
    ProjectRef,
)


@dataclass
class FakeResponse:
    status_code: int
    payload: Any = None
    text: str = ""

    def json(self) -> Any:
        if self.payload is _SENTINEL:
            raise ValueError("no json")
        return self.payload


@dataclass
class FakeHttp:
    """Route URL prefixes to canned responses. Records every call for assertions."""

    routes: dict[str, FakeResponse] = field(default_factory=dict)
    calls: list[tuple[str, Mapping[str, Any] | None, Mapping[str, str]]] = field(
        default_factory=list
    )

    def get(self, url: str, *, params=None, headers=None, timeout=None) -> FakeResponse:
        self.calls.append((url, params, headers or {}))
        for prefix, response in self.routes.items():
            if url.startswith(prefix):
                return response
        return FakeResponse(status_code=404, text=f"unrouted: {url}")


_SENTINEL = object()


@pytest.fixture(autouse=True)
def _fake_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "docket.providers.azure_devops.discover.get_azure_devops_bearer_token",
        lambda: "t0ken",
    )


@pytest.fixture
def http(monkeypatch: pytest.MonkeyPatch) -> FakeHttp:
    fake = FakeHttp()
    monkeypatch.setattr(discover.requests, "get", fake.get)
    return fake


def test_list_orgs_returns_refs_from_accounts_api(http: FakeHttp) -> None:
    http.routes = {
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me": FakeResponse(
            status_code=200, payload={"id": "member-123"}
        ),
        "https://app.vssps.visualstudio.com/_apis/accounts": FakeResponse(
            status_code=200,
            payload={
                "value": [
                    {"accountName": "contoso"},
                    {"accountName": "otherco"},
                    {"displayName": "no-name-here"},  # filtered
                ]
            },
        ),
    }
    orgs = discover.list_orgs()
    assert orgs == [
        OrgRef(name="contoso", url="https://dev.azure.com/contoso"),
        OrgRef(name="otherco", url="https://dev.azure.com/otherco"),
    ]
    # Authorization header flows into every call.
    for _, _, headers in http.calls:
        assert headers["Authorization"] == "Bearer t0ken"
    # memberId was propagated into the second call's params.
    _, accounts_params, _ = http.calls[1]
    assert accounts_params and accounts_params["memberId"] == "member-123"


def test_list_orgs_errors_when_profile_missing_id(http: FakeHttp) -> None:
    http.routes = {
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me": FakeResponse(
            status_code=200, payload={}
        ),
    }
    with pytest.raises(DiscoveryError, match="did not include an id"):
        discover.list_orgs()


def test_list_orgs_errors_on_http_failure(http: FakeHttp) -> None:
    http.routes = {
        "https://app.vssps.visualstudio.com/_apis/profile/profiles/me": FakeResponse(
            status_code=401, text="auth failed"
        ),
    }
    with pytest.raises(DiscoveryError, match="401"):
        discover.list_orgs()


def test_list_projects(http: FakeHttp) -> None:
    http.routes = {
        "https://dev.azure.com/contoso/_apis/projects": FakeResponse(
            status_code=200,
            payload={
                "value": [
                    {"id": "p1", "name": "platform"},
                    {"id": "p2", "name": "other"},
                    {"id": None, "name": "ignored"},
                ]
            },
        ),
    }
    projects = discover.list_projects("https://dev.azure.com/contoso")
    assert projects == [ProjectRef(id="p1", name="platform"), ProjectRef(id="p2", name="other")]


def test_list_projects_strips_trailing_slash_in_org(http: FakeHttp) -> None:
    http.routes = {
        "https://dev.azure.com/contoso/_apis/projects": FakeResponse(
            status_code=200, payload={"value": []}
        ),
    }
    assert discover.list_projects("https://dev.azure.com/contoso/") == []


def test_list_teams(http: FakeHttp) -> None:
    http.routes = {
        "https://dev.azure.com/org/_apis/projects/platform/teams": FakeResponse(
            status_code=200,
            payload={"value": [{"name": "Alpha"}, {"name": "Bravo"}, {"id": "x"}]},
        ),
    }
    assert discover.list_teams("https://dev.azure.com/org", "platform") == ["Alpha", "Bravo"]


def test_classification_paths_flatten_tree(http: FakeHttp) -> None:
    tree = {
        "name": "platform",
        "children": [
            {"name": "Platform", "children": [{"name": "Core"}, {"name": "Edge"}]},
            {"name": "Research"},
        ],
    }
    http.routes = {
        "https://dev.azure.com/org/platform/_apis/wit/classificationnodes/Areas": FakeResponse(
            status_code=200, payload=tree
        ),
    }
    paths = discover.list_area_paths("https://dev.azure.com/org", "platform")
    assert paths == [
        "platform",
        "platform\\Platform",
        "platform\\Platform\\Core",
        "platform\\Platform\\Edge",
        "platform\\Research",
    ]


def test_iteration_paths_share_flatten_logic(http: FakeHttp) -> None:
    tree = {
        "name": "platform",
        "children": [{"name": "Sprint 42"}],
    }
    http.routes = {
        "https://dev.azure.com/org/platform/_apis/wit/classificationnodes/Iterations": FakeResponse(
            status_code=200, payload=tree
        ),
    }
    assert discover.list_iteration_paths("https://dev.azure.com/org", "platform") == [
        "platform",
        "platform\\Sprint 42",
    ]


def test_request_exception_wraps_as_discovery_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a, **_kw):
        raise requests.ConnectionError("no route to host")

    monkeypatch.setattr(discover.requests, "get", boom)
    with pytest.raises(DiscoveryError, match="no route to host"):
        discover.list_projects("https://dev.azure.com/org")


def test_signed_in_email_returns_upn(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Result:
        stdout = '{"user": {"name": "demo@example.com"}}'

    monkeypatch.setattr(discover, "_az_path", lambda: "/usr/local/bin/az")
    monkeypatch.setattr(
        discover.subprocess,
        "run",
        lambda *a, **kw: _Result(),
    )
    assert discover.signed_in_email() == "demo@example.com"


def test_signed_in_email_returns_none_on_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_(*_a, **_kw):
        raise discover.subprocess.CalledProcessError(1, ["az"])

    monkeypatch.setattr(discover, "_az_path", lambda: "/usr/local/bin/az")
    monkeypatch.setattr(discover.subprocess, "run", raise_)
    assert discover.signed_in_email() is None
