"""Discovery helpers for the setup wizard's GitHub flow.

Mirrors `providers.azure_devops.discover`: pure I/O, no prompting, raises
`DiscoveryError` on network/auth failure. We reuse the `gh` CLI for API
calls so the wizard inherits the user's session without us touching PATs.

`gh api` is preferred over raw `api.github.com` HTTP because it handles
host overrides (GitHub Enterprise), pagination, and auth without us
re-implementing them.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

from docket.providers.base import ProviderError
from docket.providers.github.auth import _gh_path


class DiscoveryError(ProviderError):
    """Raised when GitHub auto-discovery fails. Callers typically fall back to free-form input."""


@dataclass(frozen=True)
class RepoRef:
    owner: str
    name: str  # just the repo part; the full form is f"{owner}/{name}"

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"


@dataclass(frozen=True)
class OrgRef:
    login: str  # e.g. "anthropics"


def signed_in_login() -> str | None:
    """Return the signed-in GitHub login, or None on failure.

    Safe to call in the wizard UX path — never raises. A None just means
    the wizard can't label the picker with `(you: <login>)`."""
    try:
        result = subprocess.run(
            [_gh_path(), "api", "user", "--jq", ".login"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ProviderError):
        return None
    login = result.stdout.strip()
    return login or None


def list_orgs() -> list[OrgRef]:
    """Return every org the signed-in user belongs to."""
    payload = _gh_api_json("/user/orgs", paginate=True)
    if not isinstance(payload, list):
        raise DiscoveryError("unexpected /user/orgs payload shape")
    out: list[OrgRef] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        login = entry.get("login")
        if isinstance(login, str) and login:
            out.append(OrgRef(login=login))
    return out


def list_repos(owner: str | None = None, *, limit: int = 50) -> list[RepoRef]:
    """List repos for `owner` (a user login) or the authenticated user when None.

    `limit` caps the returned set so a user on a big org doesn't wait ages
    — the wizard shows a picker, not a full listing tool. `gh` enforces
    `per_page<=100`; we pass -f sort=updated so the most recently-touched
    repos float up.

    Note: `/users/{login}/repos` returns only *public* repos. For an org
    the user is a member of, call `list_org_repos(org)` instead so private
    repos they can see also show up."""
    path = f"/users/{owner}/repos" if owner else "/user/repos"
    return _collect_repo_refs(path, limit=limit)


def list_org_repos(org: str, *, limit: int = 100) -> list[RepoRef]:
    """List every repo under `org` that the authenticated user can see.

    Uses `/orgs/{org}/repos`, which — unlike `/users/{org}/repos` — honors
    the caller's org membership and returns private repos they have access
    to. Default limit is higher than `list_repos` because org picks are
    typically where users actually work."""
    return _collect_repo_refs(f"/orgs/{org}/repos", limit=limit)


def _collect_repo_refs(path: str, *, limit: int) -> list[RepoRef]:
    per_page = min(limit, 100)
    payload = _gh_api_json(
        path,
        params=[("per_page", str(per_page)), ("sort", "updated")],
    )
    if not isinstance(payload, list):
        raise DiscoveryError(f"unexpected {path} payload shape")
    out: list[RepoRef] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        full = entry.get("full_name")
        if not isinstance(full, str) or "/" not in full:
            continue
        owner_name, name = full.split("/", 1)
        out.append(RepoRef(owner=owner_name, name=name))
        if len(out) >= limit:
            break
    return out


def list_labels(repo: str) -> list[str]:
    """Return the label names for `owner/repo`. Empty list is a legitimate result."""
    if "/" not in repo:
        raise DiscoveryError(f"repo must be 'owner/name', got {repo!r}")
    payload = _gh_api_json(f"/repos/{repo}/labels", paginate=True)
    if not isinstance(payload, list):
        raise DiscoveryError(f"unexpected /repos/{repo}/labels payload shape")
    names: list[str] = []
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _gh_api_json(
    path: str,
    *,
    params: list[tuple[str, str]] | None = None,
    paginate: bool = False,
) -> object:
    """Invoke `gh api <path>` and parse its JSON stdout.

    `paginate=True` asks `gh` to walk link headers and concatenate pages
    into a single JSON array — convenient for small enumerations (orgs,
    labels). For listings with an explicit cap we pass `per_page` instead
    so we don't accidentally pull thousands of repos."""
    cmd: list[str] = [_gh_path(), "api", path]
    if paginate:
        cmd.append("--paginate")
    for key, value in params or []:
        cmd.extend(["-f", f"{key}={value}"])
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True,
            timeout=20,
        )
    except subprocess.CalledProcessError as e:
        raise DiscoveryError(
            f"`gh api {path}` failed: {e.stderr.strip() or e.stdout.strip()}"
        ) from e
    except subprocess.TimeoutExpired as e:
        raise DiscoveryError(f"`gh api {path}` timed out after 20s") from e
    except ProviderError as e:
        raise DiscoveryError(str(e)) from e
    stdout = result.stdout.strip()
    if not stdout:
        return []
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        raise DiscoveryError(f"`gh api {path}` returned non-JSON body") from e


__all__ = [
    "DiscoveryError",
    "OrgRef",
    "RepoRef",
    "list_labels",
    "list_org_repos",
    "list_orgs",
    "list_repos",
    "signed_in_login",
]
