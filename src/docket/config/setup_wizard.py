"""First-launch setup wizard.

M1 covers steps 1, 2, 3, 7, 8, 9:

    1. Azure CLI logged-in check
    2. Azure DevOps org + project probe
    3. Scope filter prompts (with live count preview)
    7. Telemetry opt-in (on by default)
    8. Prompt template scaffold
    9. DB init + initial sync

Steps 4 (state-map probe), 5 (Foundry), and 6 (HTTP bearer token) are added in M2+
where their dependencies land. The wizard is resumable — `docket setup --step=<name>`
jumps directly to a step and writes config atomically on completion.

Auto-discovery: whenever `az` + the ADO bearer token can list orgs, projects,
teams, area paths, or iteration paths, the wizard shows a numbered picker so the
user never has to type values they could click. Any discovery failure transparently
falls back to free-form prompts — helpful for restricted networks."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlparse

from pydantic import HttpUrl, ValidationError
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from docket.config.env import load_project_env
from docket.config.loader import load_config, save_config
from docket.config.models import AdoConfig, Config, ScopeFilter, TelemetryConfig
from docket.config.paths import Paths, resolve_paths
from docket.config.prompt_templates import scaffold as scaffold_prompts
from docket.core.model import ScopeFilters
from docket.core.services import sync_service
from docket.providers.azure_devops import AzureDevOpsProvider
from docket.providers.azure_devops import discover
from docket.providers.azure_devops.auth import ensure_logged_in
from docket.providers.azure_devops.discover import DiscoveryError
from docket.providers.base import ProviderAuthError, ProviderError
from docket.storage import init_db

console = Console()

STEP_NAMES: tuple[str, ...] = (
    "az",
    "ado",
    "scope",
    "telemetry",
    "prompts",
    "sync",
)

_CUSTOM_SENTINEL = "__custom__"
_ANY_SENTINEL = "__any__"


@dataclass
class WizardState:
    paths: Paths
    ado_organization: str = ""
    ado_project: str = ""
    scope: ScopeFilter = field(default_factory=ScopeFilter)
    telemetry_enabled: bool = True
    signed_in_email: str | None = None


def run_wizard(start_at: str | None = None) -> None:
    """Drive the wizard interactively. Writes config.toml atomically at the end."""
    load_project_env()  # repo-local .env must win before paths resolve
    paths = resolve_paths()
    paths.ensure()
    state = _load_existing_state(paths)

    console.print(Panel.fit(
        "[bold]Docket setup[/bold]\n"
        "This wizard prepares your config, prompt templates, local cache, and first sync.\n"
        "You can exit at any time with Ctrl-C and resume with `docket setup`.",
        border_style="cyan",
    ))

    steps: list[tuple[str, Callable[[WizardState], None]]] = [
        ("az", _step_az_login),
        ("ado", _step_ado_connection),
        ("scope", _step_scope_filters),
        ("telemetry", _step_telemetry),
        ("prompts", _step_prompt_templates),
        ("sync", _step_db_and_sync),
    ]

    if start_at and start_at not in STEP_NAMES:
        console.print(f"[red]Unknown step '{start_at}'. Known: {', '.join(STEP_NAMES)}.[/red]")
        raise SystemExit(2)

    started = False
    for name, fn in steps:
        if start_at and not started:
            if name != start_at:
                continue
            started = True
        console.rule(f"[bold]{name}[/bold]")
        fn(state)

    config = Config(
        ado=AdoConfig(
            organization=HttpUrl(state.ado_organization),
            project=state.ado_project,
        ),
        scopes={"default": state.scope},
        active_scope="default",
        telemetry=TelemetryConfig(enabled=state.telemetry_enabled),
    )
    save_config(paths, config)
    console.print(f"[green]✓ config written to[/green] {paths.config_file}")


def _load_existing_state(paths: Paths) -> WizardState:
    state = WizardState(paths=paths)
    if paths.config_file.exists():
        try:
            cfg = load_config(paths)
        except (ValidationError, Exception):
            return state
        state.ado_organization = str(cfg.ado.organization)
        state.ado_project = cfg.ado.project
        state.scope = cfg.scopes.get("default", ScopeFilter())
        state.telemetry_enabled = cfg.telemetry.enabled
    return state


# ---- step 1 ------------------------------------------------------------------


def _step_az_login(state: WizardState) -> None:
    console.print("Checking Azure CLI session...")
    while True:
        try:
            account = ensure_logged_in()
        except ProviderAuthError as e:
            console.print(f"[yellow]{e}[/yellow]")
            if not Confirm.ask("Retry now?", default=True):
                raise SystemExit(1)
            continue
        console.print(f"[green]✓ signed in as[/green] {account}")
        state.signed_in_email = discover.signed_in_email()
        return


# ---- step 2 ------------------------------------------------------------------


def _step_ado_connection(state: WizardState) -> None:
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
                raise SystemExit(1)
            state.ado_organization = org
            state.ado_project = project
            continue
        state.ado_organization = org
        state.ado_project = project
        console.print("[green]✓ reachable[/green]")
        return


def _pick_org(state: WizardState) -> str:
    try:
        orgs = discover.list_orgs()
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list organizations ({e}) — entering manually.[/dim]")
        orgs = []
    if orgs:
        labels = [f"{o.name} ({o.url})" for o in orgs]
        choice = _pick("Azure DevOps organization", labels, allow_custom=True)
        if choice is _CUSTOM_SENTINEL:
            return _prompt_org_url(state)
        assert isinstance(choice, int)
        return orgs[choice].url
    return _prompt_org_url(state)


def _prompt_org_url(state: WizardState) -> str:
    while True:
        raw = Prompt.ask(
            "Azure DevOps organization URL",
            default=state.ado_organization or "https://dev.azure.com/your-org",
        ).strip().rstrip("/")
        if not _looks_like_http_url(raw):
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
        choice = _pick("Project", labels, allow_custom=True)
        if choice is _CUSTOM_SENTINEL:
            return _prompt_project_name(state)
        assert isinstance(choice, int)
        return projects[choice].name
    return _prompt_project_name(state)


def _prompt_project_name(state: WizardState) -> str:
    while True:
        project = Prompt.ask("Project name", default=state.ado_project or "").strip()
        if project:
            return project
        console.print("[red]Project name is required.[/red]")


def _looks_like_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


# ---- step 3 ------------------------------------------------------------------


def _step_scope_filters(state: WizardState) -> None:
    console.print(
        "Scope filters limit which work items get cached locally. "
        "Leave any axis as 'any' to include everything."
    )
    while True:
        team = _pick_optional(
            "Team",
            fetch=lambda: discover.list_teams(state.ado_organization, state.ado_project),
            current=state.scope.team,
        )
        area = _pick_optional(
            "Area path",
            fetch=lambda: discover.list_area_paths(state.ado_organization, state.ado_project),
            current=state.scope.area_path,
        )
        iteration = _pick_optional(
            "Iteration path",
            fetch=lambda: discover.list_iteration_paths(
                state.ado_organization, state.ado_project
            ),
            current=state.scope.iteration_path,
        )
        assignee = _pick_assignee(state)
        scope = ScopeFilter(
            team=team,
            area_path=area,
            iteration_path=iteration,
            assignee=assignee,
        )

        count = _count_items_for_scope(state, scope)
        if count is None:
            console.print("[yellow]Could not count items — proceeding with this scope.[/yellow]")
        else:
            console.print(f"[cyan]→ {count} item(s) match this scope[/cyan]")

        if Confirm.ask("Use this scope?", default=True):
            state.scope = scope
            return


def _pick_optional(
    label: str,
    *,
    fetch: Callable[[], list[str]],
    current: str,
) -> str:
    """Offer discovered options plus 'any' and 'custom…'. Returns '' for 'any'."""
    options: list[str] = []
    try:
        options = [o for o in fetch() if o]
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't list {label.lower()}s ({e}) — entering manually.[/dim]")
    if not options:
        raw = Prompt.ask(f"{label} (blank for any)", default=current or "")
        return raw.strip()

    # Put the previously-chosen value first if it's still a valid option.
    if current and current in options:
        options = [current] + [o for o in options if o != current]
    choice = _pick(label, options, allow_any=True, allow_custom=True)
    if choice is _ANY_SENTINEL:
        return ""
    if choice is _CUSTOM_SENTINEL:
        raw = Prompt.ask(f"{label} (free-form)", default=current or "")
        return raw.strip()
    assert isinstance(choice, int)
    return options[choice]


def _pick_assignee(state: WizardState) -> str:
    """Offer @me, the detected email, any, and custom. Returns '' for 'any'."""
    options: list[str] = ["@me"]
    if state.signed_in_email and state.signed_in_email not in options:
        options.append(state.signed_in_email)
    # Put the current value first if it's already in the list.
    current = state.scope.assignee
    if current and current in options:
        options = [current] + [o for o in options if o != current]
    choice = _pick("Assignee", options, allow_any=True, allow_custom=True)
    if choice is _ANY_SENTINEL:
        return ""
    if choice is _CUSTOM_SENTINEL:
        raw = Prompt.ask("Assignee (email or @me)", default=current or "@me").strip()
        return raw
    assert isinstance(choice, int)
    return options[choice]


def _pick(
    label: str,
    options: list[str],
    *,
    allow_any: bool = False,
    allow_custom: bool = False,
) -> int | str:
    """Render a numbered chooser. Returns an int index or a sentinel ('any' / 'custom')."""
    console.print(f"[bold]{label}:[/bold]")
    for i, opt in enumerate(options, start=1):
        console.print(f"  [cyan]{i}[/cyan]. {opt}")
    extras: list[str] = []
    any_key = str(len(options) + 1) if allow_any else None
    custom_key = str(len(options) + (2 if allow_any else 1)) if allow_custom else None
    if any_key is not None:
        console.print(f"  [cyan]{any_key}[/cyan]. any")
        extras.append(any_key)
    if custom_key is not None:
        console.print(f"  [cyan]{custom_key}[/cyan]. custom…")
        extras.append(custom_key)
    valid_numeric = [str(i) for i in range(1, len(options) + 1)] + extras
    raw = Prompt.ask("Choose", choices=valid_numeric, default="1", show_choices=False)
    if any_key and raw == any_key:
        return _ANY_SENTINEL
    if custom_key and raw == custom_key:
        return _CUSTOM_SENTINEL
    return int(raw) - 1


def _count_items_for_scope(state: WizardState, scope: ScopeFilter) -> int | None:
    try:
        provider = AzureDevOpsProvider(
            organization_url=state.ado_organization,
            project=state.ado_project,
        )
        filters = ScopeFilters(
            team=scope.team,
            area_path=scope.area_path,
            iteration_path=scope.iteration_path,
            assignee=scope.assignee,
        )
        items = list(provider.list_changes_since(None, filters))
        return len(items)
    except ProviderError:
        return None


# ---- step 7 ------------------------------------------------------------------


def _step_telemetry(state: WizardState) -> None:
    console.print(
        f"Local structured logs and the token/cost ledger land at [cyan]{state.paths.cache_dir}[/cyan].\n"
        "Nothing is shipped off-device. You can disable this later with `docket config telemetry disable`."
    )
    state.telemetry_enabled = Confirm.ask("Keep local telemetry enabled?", default=True)


# ---- step 8 ------------------------------------------------------------------


def _step_prompt_templates(state: WizardState) -> None:
    created = scaffold_prompts(state.paths.prompts_dir)
    if created:
        console.print(
            f"[green]✓ scaffolded {len(created)} template(s)[/green] at {state.paths.prompts_dir}"
        )
        for name in created:
            console.print(f"    {name}")
    else:
        console.print(f"Templates already present at {state.paths.prompts_dir} — no changes.")


# ---- step 9 ------------------------------------------------------------------


def _step_db_and_sync(state: WizardState) -> None:
    console.print(f"Initializing database at [cyan]{state.paths.db_file}[/cyan]...")
    conn = init_db(state.paths.db_file)
    try:
        provider = AzureDevOpsProvider(
            organization_url=state.ado_organization,
            project=state.ado_project,
        )
        filters = ScopeFilters(
            team=state.scope.team,
            area_path=state.scope.area_path,
            iteration_path=state.scope.iteration_path,
            assignee=state.scope.assignee,
        )
        console.print("Running initial full sync...")
        summary = sync_service.full_refresh(conn, provider, "default", filters)
        console.print(
            f"[green]✓ synced {summary.upserted} item(s)[/green] "
            f"(archived {summary.archived}, watermark {summary.watermark})"
        )
    finally:
        conn.close()
