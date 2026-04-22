"""Discovery helpers for the setup wizard.

These functions turn the user's `az` session into concrete selection choices so
the wizard doesn't have to ask them to hand-type org URLs, project names, team
names, area paths, or iteration paths. Every call reuses the short-lived Azure DevOps
bearer token minted from `az` — no PATs, no extra auth.

Design rules:
- Pure I/O; no prompting, no config writes. The wizard owns UX.
- Each function either returns a list (possibly empty) on success or raises
  `DiscoveryError`. Empty results are a legitimate outcome — the caller decides
  whether to fall back.
- Timeouts are short so a misconfigured proxy fails fast; we don't want the
  wizard to hang for minutes on a stale DNS response.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any

import requests  # type: ignore[import-untyped]

from docket.providers.azure_devops.auth import _az_path, get_azure_devops_bearer_token
from docket.providers.base import ProviderError

_VSSPS_BASE = "https://app.vssps.visualstudio.com"
_TIMEOUT = 15  # seconds — generous for slow corp networks, still fast enough to not feel frozen


class DiscoveryError(ProviderError):
    """Raised when auto-discovery fails. Callers typically fall back to free-form input."""


@dataclass(frozen=True)
class OrgRef:
    name: str  # e.g. "contoso"
    url: str  # e.g. "https://dev.azure.com/contoso"


@dataclass(frozen=True)
class ProjectRef:
    id: str
    name: str


def signed_in_email() -> str | None:
    """Return the signed-in user's UPN from `az account show`, or None on failure.

    Safe to call in the wizard's UX path — never raises; a None just means
    "can't pre-populate the assignee field"."""
    try:
        result = subprocess.run(
            [_az_path(), "account", "show", "-o", "json"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        payload = json.loads(result.stdout)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        json.JSONDecodeError,
        ProviderError,
    ):
        return None
    email = payload.get("user", {}).get("name")
    return email if isinstance(email, str) and email else None


def list_orgs() -> list[OrgRef]:
    """Return every Azure DevOps organization the signed-in user belongs to.

    Two-step: profile/me → memberId, then accounts?memberId=…. Each "account" is
    an org in Azure DevOps terminology."""
    me = _get_json(f"{_VSSPS_BASE}/_apis/profile/profiles/me?api-version=7.1-preview.3")
    member_id = me.get("id")
    if not member_id:
        raise DiscoveryError("profile/me response did not include an id")
    accounts = _get_json(
        f"{_VSSPS_BASE}/_apis/accounts",
        params={"memberId": member_id, "api-version": "7.1-preview.1"},
    )
    orgs: list[OrgRef] = []
    for acc in accounts.get("value", []) or []:
        name = acc.get("accountName")
        if not name:
            continue
        orgs.append(OrgRef(name=name, url=f"https://dev.azure.com/{name}"))
    return orgs


def list_projects(org_url: str) -> list[ProjectRef]:
    base = org_url.rstrip("/")
    payload = _get_json(f"{base}/_apis/projects", params={"api-version": "7.1-preview.4"})
    out: list[ProjectRef] = []
    for p in payload.get("value", []) or []:
        pid = p.get("id")
        name = p.get("name")
        if pid and name:
            out.append(ProjectRef(id=pid, name=name))
    return out


def list_teams(org_url: str, project: str) -> list[str]:
    base = org_url.rstrip("/")
    payload = _get_json(
        f"{base}/_apis/projects/{project}/teams",
        params={"api-version": "7.1-preview.3"},
    )
    return [t["name"] for t in payload.get("value", []) or [] if t.get("name")]


def list_area_paths(org_url: str, project: str, depth: int = 5) -> list[str]:
    return _classification_paths(org_url, project, "Areas", depth)


def list_iteration_paths(org_url: str, project: str, depth: int = 5) -> list[str]:
    return _classification_paths(org_url, project, "Iterations", depth)


def _classification_paths(org_url: str, project: str, structure: str, depth: int) -> list[str]:
    base = org_url.rstrip("/")
    payload = _get_json(
        f"{base}/{project}/_apis/wit/classificationnodes/{structure}",
        params={"$depth": str(depth), "api-version": "7.1-preview.2"},
    )
    out: list[str] = []
    _collect_node_paths(payload, prefix=project, sink=out)
    return out


def _collect_node_paths(node: dict[str, Any], *, prefix: str, sink: list[str]) -> None:
    """Walk the classification-node tree and flatten it into backslash-delimited paths.

    Azure DevOps's public display form is `Project\\Parent\\Child`. The root node itself
    shares the project name, so the root's emitted path is just the project."""
    name = node.get("name")
    if not name:
        return
    # Root node from the API uses the project name; we treat it as the bare project.
    current = prefix if name == prefix else f"{prefix}\\{name}"
    sink.append(current)
    for child in node.get("children", []) or []:
        _collect_node_paths(child, prefix=current, sink=sink)


def _get_json(url: str, *, params: dict[str, str] | None = None) -> dict[str, Any]:
    try:
        token = get_azure_devops_bearer_token()
    except ProviderError as e:
        raise DiscoveryError(str(e)) from e
    try:
        resp = requests.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            timeout=_TIMEOUT,
        )
    except requests.RequestException as e:
        raise DiscoveryError(f"request to {url} failed: {e}") from e
    if resp.status_code >= 400:
        raise DiscoveryError(f"{url} returned {resp.status_code}: {resp.text[:200]}")
    try:
        payload: dict[str, Any] = resp.json()
    except ValueError as e:
        raise DiscoveryError(f"{url} returned non-JSON body") from e
    return payload


__all__ = [
    "DiscoveryError",
    "OrgRef",
    "ProjectRef",
    "list_area_paths",
    "list_iteration_paths",
    "list_orgs",
    "list_projects",
    "list_teams",
    "signed_in_email",
]
