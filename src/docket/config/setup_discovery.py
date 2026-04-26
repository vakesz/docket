"""Setup wizard discovery shims, callable from any surface.

The CLI wizard imports concrete provider modules directly (`config/` is not
subject to the import-boundary guard). The HTTP wizard cannot — `api/` is
guarded by `tests/unit/test_import_boundary.py`. This module is a thin
relay so the HTTP routes can import discovery results from `config/` and
keep the boundary clean.

Each function mirrors a step the terminal wizard already runs (`gh auth
status`, `az account get-access-token`, `gh api /user/repos`, etc.).
Failures map to the helper's native exceptions (`DiscoveryError`,
`ProviderAuthError`); callers translate them into surface-appropriate
responses (rich console for CLI, DTO `ok=false` for HTTP)."""

from __future__ import annotations

import shutil
from dataclasses import dataclass

from docket.providers.azure_devops import discover as ado_discover
from docket.providers.azure_devops.auth import (
    ensure_logged_in as az_ensure_logged_in,
)
from docket.providers.azure_devops.discover import DiscoveryError as AdoDiscoveryError
from docket.providers.azure_devops.discover import OrgRef as AdoOrgRef
from docket.providers.base import ProviderAuthError
from docket.providers.github import discover as gh_discover
from docket.providers.github.auth import ensure_logged_in as gh_ensure_logged_in
from docket.providers.github.discover import DiscoveryError as GhDiscoveryError
from docket.providers.github.discover import HostRef as GhHostRef
from docket.providers.github.discover import OrgRef as GhOrgRef
from docket.providers.github.discover import RepoRef as GhRepoRef


@dataclass(frozen=True)
class CliToolStatus:
    """Result of a single CLI session probe.

    `present=False` means the binary isn't on PATH — the wizard renders
    install instructions. `present=True` + `logged_in=False` means it's
    installed but the session is gone — wizard prompts the user to run
    `gh auth login` / `az login` and click retry."""

    name: str
    present: bool
    logged_in: bool
    identity: str = ""
    error: str = ""


def probe_az() -> CliToolStatus:
    """Probe the local `az` CLI session, never raising."""
    if shutil.which("az") is None:
        return CliToolStatus(name="az", present=False, logged_in=False)
    try:
        identity = az_ensure_logged_in()
    except ProviderAuthError as e:
        return CliToolStatus(name="az", present=True, logged_in=False, error=str(e))
    return CliToolStatus(name="az", present=True, logged_in=True, identity=identity)


def probe_gh() -> CliToolStatus:
    """Probe the local `gh` CLI session, never raising."""
    if shutil.which("gh") is None:
        return CliToolStatus(name="gh", present=False, logged_in=False)
    try:
        identity = gh_ensure_logged_in()
    except ProviderAuthError as e:
        return CliToolStatus(name="gh", present=True, logged_in=False, error=str(e))
    return CliToolStatus(name="gh", present=True, logged_in=True, identity=identity)


def list_gh_hosts() -> list[GhHostRef]:
    """Re-export `gh_discover.list_hosts` so the API layer stays out of providers/."""
    return gh_discover.list_hosts()


def ado_list_orgs() -> list[AdoOrgRef]:
    return ado_discover.list_orgs()


def ado_list_projects(org: str) -> list[str]:
    return [p.name for p in ado_discover.list_projects(org)]


def ado_list_teams(org: str, project: str) -> list[str]:
    return ado_discover.list_teams(org, project)


def ado_list_areas(org: str, project: str) -> list[str]:
    return ado_discover.list_area_paths(org, project)


def ado_list_iterations(org: str, project: str) -> list[str]:
    return ado_discover.list_iteration_paths(org, project)


def gh_list_repos(host: str | None) -> list[GhRepoRef]:
    return gh_discover.list_repos(host=host)


def gh_list_orgs(host: str | None) -> list[GhOrgRef]:
    return gh_discover.list_orgs(host=host)


def gh_list_org_repos(org: str, host: str | None) -> list[GhRepoRef]:
    return gh_discover.list_org_repos(org, host=host)


__all__ = [
    "AdoDiscoveryError",
    "AdoOrgRef",
    "CliToolStatus",
    "GhDiscoveryError",
    "GhHostRef",
    "GhOrgRef",
    "GhRepoRef",
    "ado_list_areas",
    "ado_list_iterations",
    "ado_list_orgs",
    "ado_list_projects",
    "ado_list_teams",
    "gh_list_org_repos",
    "gh_list_orgs",
    "gh_list_repos",
    "list_gh_hosts",
    "probe_az",
    "probe_gh",
]
