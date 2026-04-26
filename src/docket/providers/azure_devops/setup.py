"""First-time setup hooks for the Azure DevOps provider.

Owns the `az login` retry loop, the org/project pickers (with manual
fallback), and the team/area/iteration default-view picker. Importing this
module registers the callbacks with `config.setup_hooks`; the wizard
dispatches to them when the user picks `azure_devops` as the provider type.

Kept separate from `provider.py` so the actual `WorkItemProvider`
implementation doesn't drag Rich + the Confirm/Prompt UX surface into every
runtime that builds an ADO provider."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING

from pydantic import HttpUrl
from rich.prompt import Confirm, Prompt

from docket._console import console
from docket.config.setup_hooks import DiscoveryItem, WizardHooks
from docket.config.setup_hooks import register as register_hooks
from docket.config.setup_utils import (
    looks_like_http_url,
    pick,
    pick_assignee,
    step_auth_with_retry,
)
from docket.providers.azure_devops import discover
from docket.providers.azure_devops.auth import ensure_logged_in
from docket.providers.azure_devops.discover import DiscoveryError
from docket.providers.azure_devops.provider import AzureDevOpsProvider
from docket.providers.base import ProviderError

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


def step_auth(state: WizardState) -> None:
    step_auth_with_retry(ensure_logged_in, service_label="Azure CLI")
    state.signed_in_email = discover.signed_in_email()


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


def step_view(state: WizardState) -> None:
    """Seed the default saved view's assignee + axes for Azure DevOps.

    Sync is full-project; this just picks the chip-bar starting point so
    the user lands on a usable subset on first open. Multiple values per
    axis are supported in-app via the chip bar — the wizard captures one
    initial value to keep the prompt short."""
    from docket.config.models import SavedView

    org = str(state.provider_config.get("organization", ""))
    project = str(state.provider_config.get("project", ""))
    console.print(
        "Saved views narrow what the items pane shows. "
        "Leave any axis as 'any' to start unfiltered — you can adjust "
        "from the chip bar at any time."
    )
    while True:
        team = _pick_optional(
            "Team",
            fetch=lambda: discover.list_teams(org, project),
            current=_first(state.view.axes.get("team", [])),
        )
        area = _pick_optional(
            "Area path",
            fetch=lambda: discover.list_area_paths(org, project),
            current=_first(state.view.axes.get("area_path", [])),
        )
        iteration = _pick_optional(
            "Iteration path",
            fetch=lambda: discover.list_iteration_paths(org, project),
            current=_first(state.view.axes.get("iteration_path", [])),
        )
        assignee = pick_assignee(
            signed_in_email=state.signed_in_email,
            current_assignee=_first(state.view.assignees),
        )
        axes: dict[str, list[str]] = {
            k: [v]
            for k, v in (("team", team), ("area_path", area), ("iteration_path", iteration))
            if v
        }
        assignees = [assignee] if assignee else []
        view = SavedView(assignees=assignees, axes=axes)

        if Confirm.ask("Use this default view?", default=True):
            state.view = view
            return


def _first(values: list[str]) -> str:
    """Return the first non-empty entry of `values`, or ''.

    The wizard captures one initial value per axis even though the runtime
    model is multi-select; the chip bar handles adding more after first
    launch. This collapses an existing multi-select view down to its
    leading entry so re-running the wizard doesn't surprise the user with
    silently-dropped values."""
    return values[0] if values else ""


def _pick_org(state: WizardState) -> str:
    try:
        orgs = discover.list_orgs()
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list organizations ({e}) — entering manually.[/dim]")
        orgs = []
    if not orgs:
        return _prompt_org_url(state)
    labels = [f"{o.name} ({o.url})" for o in orgs]
    match pick("Azure DevOps organization", labels, allow_custom=True):
        case "__custom__":
            return _prompt_org_url(state)
        case int(idx):
            return orgs[idx].url


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
    if not projects:
        return _prompt_project_name(state)
    labels = [p.name for p in projects]
    match pick("Project", labels, allow_custom=True):
        case "__custom__":
            return _prompt_project_name(state)
        case int(idx):
            return projects[idx].name


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

    match pick(label, options, allow_any=True, allow_custom=True):
        case "__any__":
            return ""
        case "__custom__":
            return Prompt.ask(f"{label} (free-form)", default=current or "").strip()
        case int(idx):
            return options[idx]


def discover_step(stage: str, payload: Mapping[str, str]) -> list[DiscoveryItem]:
    """Stage-driven discovery for the SPA wizard's pickers.

    Stage map (1:1 with `providers.azure_devops.discover`):
      - `orgs`       → no payload → `[{value=url, label=name}]`
      - `projects`   → `{org}` → `[{value=name, label=name}]`
      - `teams`      → `{org, project}` → `[{value=name, label=name}]`
      - `areas`      → `{org, project}` → `[{value=path, label=path}]`
      - `iterations` → `{org, project}` → `[{value=path, label=path}]`

    `DiscoveryError` from the underlying helper bubbles up; the route
    catches it and surfaces `ok=false` with the human-readable message.
    Unknown stages raise `ValueError` so the route returns the same
    `ok=false` instead of a 500."""
    if stage == "orgs":
        return [DiscoveryItem(value=o.url, label=o.name) for o in discover.list_orgs()]
    if stage == "projects":
        org = payload.get("org", "").strip()
        if not org:
            raise ValueError("payload.org is required for stage 'projects'")
        return [DiscoveryItem(value=p.name, label=p.name) for p in discover.list_projects(org)]
    if stage in ("teams", "areas", "iterations"):
        org = payload.get("org", "").strip()
        project = payload.get("project", "").strip()
        if not org or not project:
            raise ValueError(f"payload.org and payload.project are required for stage '{stage}'")
        match stage:
            case "teams":
                items = discover.list_teams(org, project)
            case "areas":
                items = discover.list_area_paths(org, project)
            case _:
                items = discover.list_iteration_paths(org, project)
        return [DiscoveryItem(value=v, label=v) for v in items]
    raise ValueError(f"unknown stage: {stage!r}")


def register() -> None:
    register_hooks(
        "azure_devops",
        WizardHooks(
            auth=step_auth,
            connection=step_connection,
            view=step_view,
            discover=discover_step,
        ),
    )


__all__ = ["discover_step", "register", "step_auth", "step_connection", "step_view"]
