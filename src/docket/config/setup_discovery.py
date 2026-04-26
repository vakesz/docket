"""CLI session probes for the setup wizard.

The wizard's first step asks "is `gh` / `az` installed and signed in?" so
the rest of the flow can show retry-after-login UX. Probes live here
(rather than under `providers/<x>/`) because they are about the local
session, not about an active provider, and the API layer cannot import
concrete provider modules — `tests/unit/test_import_boundary.py` enforces
that boundary.

Provider-specific *discovery* (orgs, repos, teams, …) lives on each
provider's `setup.WizardHooks.discover` callback and is dispatched
through `docket.config.setup_hooks`. The HTTP wizard reaches it via the
generic `/api/setup/providers/{type_id}/discover` route."""

from __future__ import annotations

import shutil
from dataclasses import dataclass

from docket.providers.azure_devops.auth import (
    ensure_logged_in as az_ensure_logged_in,
)
from docket.providers.base import ProviderAuthError
from docket.providers.github import discover as gh_discover
from docket.providers.github.auth import ensure_logged_in as gh_ensure_logged_in
from docket.providers.github.discover import HostRef as GhHostRef


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


__all__ = [
    "CliToolStatus",
    "GhHostRef",
    "list_gh_hosts",
    "probe_az",
    "probe_gh",
]
