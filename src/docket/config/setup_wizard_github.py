"""GitHub wizard steps.

Companion to `setup_wizard_azure_devops` — the orchestrator dispatches here
for `github` / `github_stub` provider types. `github_stub` only exposes a
connection step because it runs entirely in-memory (no auth, no scope
filtering beyond `assignee`, no discovery)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from rich.prompt import Prompt

from docket.config.models import ScopeFilter
from docket.config.setup_utils import (
    console,
    pick_assignee,
    pick_github_host,
    pick_github_repo,
    step_auth_with_retry,
)

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


def step_auth(state: WizardState) -> None:
    from docket.providers.github.auth import (
        ensure_logged_in as gh_ensure_logged_in,
    )
    from docket.providers.github.auth import (
        signed_in_email as gh_signed_in_email,
    )

    step_auth_with_retry(gh_ensure_logged_in, service_label="GitHub CLI")
    state.signed_in_email = gh_signed_in_email()


def step_connection(state: WizardState) -> None:
    host = pick_github_host()
    repo = pick_github_repo(host=host.hostname if host else None)
    config: dict[str, Any] = {"default_repo": repo}
    if host and host.api_base_url != "https://api.github.com":
        config["base_url"] = host.api_base_url
    state.provider_config = config
    # Store the hostname as a hint for the label step's default — doesn't
    # persist to config.toml; only `base_url` / `default_repo` do.
    state.signed_in_github_host = host.hostname if host else None


def step_stub_connection(state: WizardState) -> None:
    current = str(state.provider_config.get("default_repo", "example/repo"))
    repo = Prompt.ask("Default repo (owner/name)", default=current).strip() or current
    state.provider_config = {"default_repo": repo}


def step_scope(state: WizardState) -> None:
    """GitHub scope is just the assignee — team/area/iteration don't apply."""
    console.print(
        "Scope filters limit which issues/PRs get cached locally. "
        "Only 'assignee' is meaningful for GitHub."
    )
    assignee = pick_assignee(
        signed_in_email=state.signed_in_email,
        current_assignee=state.scope.assignee,
    )
    state.scope = ScopeFilter(assignee=assignee)


__all__ = ["step_auth", "step_connection", "step_scope", "step_stub_connection"]
