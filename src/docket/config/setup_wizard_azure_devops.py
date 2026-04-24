"""Azure DevOps wizard steps.

The setup wizard's per-provider logic used to live inside `setup_wizard.py`;
extracting it keeps each provider's onboarding path self-contained and makes
the orchestration file (`setup_wizard.py`) focus on step ordering + shared
host settings.

Each public `step_*` entrypoint accepts a `WizardState` and mutates it in
place — same contract the orchestrator expects. Discovery failures fall back
to free-form prompts transparently."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from pydantic import HttpUrl
from rich.prompt import Confirm, Prompt

from docket.config.models import ScopeFilter
from docket.config.setup_utils import (
    ANY_SENTINEL,
    CUSTOM_SENTINEL,
    console,
    looks_like_http_url,
    pick,
    pick_assignee,
)
from docket.providers.azure_devops import AzureDevOpsProvider, discover
from docket.providers.azure_devops.auth import ensure_logged_in
from docket.providers.azure_devops.discover import DiscoveryError
from docket.providers.base import ProviderAuthError, ProviderError

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


def step_auth(state: WizardState) -> None:
    console.print("Checking Azure CLI session...")
    while True:
        try:
            account = ensure_logged_in()
        except ProviderAuthError as e:
            console.print(f"[yellow]{e}[/yellow]")
            if not Confirm.ask("Retry now?", default=True):
                raise SystemExit(1) from e
            continue
        console.print(f"[green]✓ signed in as[/green] {account}")
        state.signed_in_email = discover.signed_in_email()
        return


def step_connection(state: WizardState) -> None:
    """Pick org and project — from discovery when available, manual otherwise."""
    while True:
        org = _pick_org(state)
        project = _pick_project(state, org)
        console.print(f"Probing {org}/{project}...")
        provider = AzureDevOpsProvider(organization_url=org, project=project)
        try:
            provider.health_check()
        except ProviderError as e:
            console.print(f"[red]Connection failed:[/red] {e}")
            if not Confirm.ask("Try different values?", default=True):
                raise SystemExit(1) from e
            state.provider_config = {"organization": org, "project": project}
            continue
        state.provider_config = {
            "organization": str(HttpUrl(org)),
            "project": project,
        }
        console.print("[green]✓ reachable[/green]")
        return


def step_scope(state: WizardState) -> None:
    org = str(state.provider_config.get("organization", ""))
    project = str(state.provider_config.get("project", ""))
    console.print(
        "Scope filters limit which work items get cached locally. "
        "Leave any axis as 'any' to include everything."
    )
    while True:
        team = _pick_optional(
            "Team",
            fetch=lambda: discover.list_teams(org, project),
            current=state.scope.team,
        )
        area = _pick_optional(
            "Area path",
            fetch=lambda: discover.list_area_paths(org, project),
            current=state.scope.area_path,
        )
        iteration = _pick_optional(
            "Iteration path",
            fetch=lambda: discover.list_iteration_paths(org, project),
            current=state.scope.iteration_path,
        )
        assignee = pick_assignee(
            signed_in_email=state.signed_in_email,
            current_assignee=state.scope.assignee,
        )
        scope = ScopeFilter(
            team=team,
            area_path=area,
            iteration_path=iteration,
            assignee=assignee,
        )

        count = _count_items_for_scope(org, project, scope)
        if count is None:
            console.print("[yellow]Could not count items — proceeding with this scope.[/yellow]")
        else:
            console.print(f"[cyan]→ {count} item(s) match this scope[/cyan]")

        if Confirm.ask("Use this scope?", default=True):
            state.scope = scope
            return


def _pick_org(state: WizardState) -> str:
    try:
        orgs = discover.list_orgs()
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list organizations ({e}) — entering manually.[/dim]")
        orgs = []
    if orgs:
        labels = [f"{o.name} ({o.url})" for o in orgs]
        choice = pick("Azure DevOps organization", labels, allow_custom=True)
        if choice is CUSTOM_SENTINEL:
            return _prompt_org_url(state)
        assert isinstance(choice, int)
        return orgs[choice].url
    return _prompt_org_url(state)


def _prompt_org_url(state: WizardState) -> str:
    current = str(state.provider_config.get("organization", ""))
    while True:
        raw = (
            Prompt.ask(
                "Azure DevOps organization URL",
                default=current or "https://dev.azure.com/your-org",
            )
            .strip()
            .rstrip("/")
        )
        if not looks_like_http_url(raw):
            console.print(
                "[red]Please enter a full URL (e.g. https://dev.azure.com/your-org).[/red]"
            )
            continue
        return raw


def _pick_project(state: WizardState, org_url: str) -> str:
    try:
        projects = discover.list_projects(org_url)
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list projects ({e}) — entering manually.[/dim]")
        projects = []
    if projects:
        labels = [p.name for p in projects]
        choice = pick("Project", labels, allow_custom=True)
        if choice is CUSTOM_SENTINEL:
            return _prompt_project_name(state)
        assert isinstance(choice, int)
        return projects[choice].name
    return _prompt_project_name(state)


def _prompt_project_name(state: WizardState) -> str:
    current = str(state.provider_config.get("project", ""))
    while True:
        project = Prompt.ask("Project name", default=current or "").strip()
        if project:
            return project
        console.print("[red]Project name is required.[/red]")


def _pick_optional(
    label: str,
    *,
    fetch: Callable[[], list[str]],
    current: str,
) -> str:
    """Offer discovered options plus 'any' and 'custom…'. Returns '' for 'any'.

    'any' is always rendered first and is the default — browsing an unfamiliar
    org/repo almost always wants "everything", not whichever team happened to
    sort alphabetically first."""
    options: list[str] = []
    try:
        options = [o for o in fetch() if o]
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't list {label.lower()}s ({e}) — entering manually.[/dim]")
    if not options:
        raw = Prompt.ask(f"{label} (blank for any)", default=current or "")
        return raw.strip()

    choice = pick(label, options, allow_any=True, allow_custom=True)
    if choice is ANY_SENTINEL:
        return ""
    if choice is CUSTOM_SENTINEL:
        raw = Prompt.ask(f"{label} (free-form)", default=current or "")
        return raw.strip()
    assert isinstance(choice, int)
    return options[choice]


def _count_items_for_scope(org: str, project: str, scope: ScopeFilter) -> int | None:
    try:
        provider = AzureDevOpsProvider(organization_url=org, project=project)
        items = list(provider.list_changes_since(None, scope.to_core()))
        return len(items)
    except ProviderError:
        return None


__all__ = ["step_auth", "step_connection", "step_scope"]
