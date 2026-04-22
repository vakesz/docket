"""First-launch setup wizard.

The wizard walks the user through az login → ADO probe → scope → telemetry →
prompt scaffold → DB/first sync. Output shape: each backend is an entry under
`providers`, with `active_provider` pointing at the default one.

`--step=<name>` jumps directly to a step and writes config atomically on
completion.

Auto-discovery: whenever `az` + the ADO bearer token can list orgs, projects,
teams, area paths, or iteration paths, the wizard shows a numbered picker so the
user never has to type values they could click. Any discovery failure transparently
falls back to free-form prompts — helpful for restricted networks."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from urllib.parse import urlparse

from pydantic import HttpUrl, ValidationError
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from docket.config.loader import load_config, save_config
from docket.config.models import (
    Config,
    HttpConfig,
    ProviderEntry,
    ScopeFilter,
    TelemetryConfig,
)
from docket.config.paths import Paths, resolve_paths
from docket.config.prompt_templates import scaffold as scaffold_prompts
from docket.core.services import sync_service
from docket.providers.azure_devops import AzureDevOpsProvider, discover
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
    "http",
    "prompts",
    "sync",
)

_CUSTOM_SENTINEL = "__custom__"
_ANY_SENTINEL = "__any__"

_DEFAULT_PROVIDER_KEY = "ado"
_DEFAULT_PROVIDER_DISPLAY = "Azure DevOps"


@dataclass
class WizardState:
    paths: Paths
    ado_organization: str = ""
    ado_project: str = ""
    scope: ScopeFilter = field(default_factory=ScopeFilter)
    telemetry_enabled: bool = True
    http_enabled: bool = True
    http_bind: str = "127.0.0.1"
    http_port: int = 8765
    http_token: str = ""
    signed_in_email: str | None = None


def run_wizard(start_at: str | None = None) -> None:
    """Drive the wizard interactively. Writes config.toml atomically at the end."""
    paths = resolve_paths()
    paths.ensure()
    state = _load_existing_state(paths)

    console.print(
        Panel.fit(
            "[bold]Docket setup[/bold]\n"
            "This wizard prepares your config, prompt templates, local cache, and first sync.\n"
            "You can exit at any time with Ctrl-C and resume with `docket setup`.",
            border_style="cyan",
        )
    )

    steps: list[tuple[str, Callable[[WizardState], None]]] = [
        ("az", _step_az_login),
        ("ado", _step_ado_connection),
        ("scope", _step_scope_filters),
        ("telemetry", _step_telemetry),
        ("http", _step_http_surface),
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

    config = _build_config_from_state(state)
    save_config(paths, config)
    console.print(f"[green]✓ config written to[/green] {paths.config_file}")


def _build_config_from_state(state: WizardState) -> Config:
    """Compose the Config object the wizard just assembled in memory.

    Preserves any existing providers (so re-running the wizard doesn't wipe
    a hand-added github_stub) and upserts the default ADO entry under the
    canonical `ado` key."""
    providers: dict[str, ProviderEntry] = {}
    if state.paths.config_file.exists():
        try:
            existing = load_config(state.paths)
            providers = dict(existing.providers)
        except (ValidationError, Exception):
            providers = {}

    ado_entry = providers.get(_DEFAULT_PROVIDER_KEY)
    scopes = dict(ado_entry.scopes) if ado_entry else {}
    scopes["default"] = state.scope
    providers[_DEFAULT_PROVIDER_KEY] = ProviderEntry(
        type="azure_devops",
        display_name=_DEFAULT_PROVIDER_DISPLAY,
        config={
            "organization": str(HttpUrl(state.ado_organization)),
            "project": state.ado_project,
        },
        scopes=scopes,
        active_scope="default",
    )
    return Config(
        providers=providers,
        active_provider=_DEFAULT_PROVIDER_KEY,
        telemetry=TelemetryConfig(enabled=state.telemetry_enabled),
        http=HttpConfig(
            enabled=state.http_enabled,
            bind=state.http_bind,
            port=state.http_port,
            token=state.http_token,
        ),
    )


def _load_existing_state(paths: Paths) -> WizardState:
    state = WizardState(paths=paths)
    if paths.config_file.exists():
        try:
            cfg = load_config(paths)
        except (ValidationError, Exception):
            return state
        entry = cfg.providers.get(_DEFAULT_PROVIDER_KEY) or cfg.providers.get(cfg.active_provider)
        if entry is not None and entry.type == "azure_devops":
            state.ado_organization = str(entry.config.get("organization", ""))
            state.ado_project = str(entry.config.get("project", ""))
            state.scope = entry.scopes.get(entry.active_scope) or entry.scopes.get(
                "default", ScopeFilter()
            )
        state.telemetry_enabled = cfg.telemetry.enabled
        state.http_enabled = cfg.http.enabled
        state.http_bind = cfg.http.bind
        state.http_port = cfg.http.port
        state.http_token = cfg.http.token
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
                raise SystemExit(1) from e
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
                raise SystemExit(1) from e
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
        raw = (
            Prompt.ask(
                "Azure DevOps organization URL",
                default=state.ado_organization or "https://dev.azure.com/your-org",
            )
            .strip()
            .rstrip("/")
        )
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
            fetch=lambda: discover.list_iteration_paths(state.ado_organization, state.ado_project),
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
        items = list(provider.list_changes_since(None, scope.to_core()))
        return len(items)
    except ProviderError:
        return None


# ---- step 7 ------------------------------------------------------------------


def _step_telemetry(state: WizardState) -> None:
    console.print(
        f"Local structured logs and the token/cost ledger land at [cyan]{state.paths.cache_dir}[/cyan].\n"
        "Nothing is shipped off-device. You can change this later from the in-app settings screen or config.toml."
    )
    state.telemetry_enabled = Confirm.ask("Keep local telemetry enabled?", default=True)


# ---- step 7b -----------------------------------------------------------------


def _step_http_surface(state: WizardState) -> None:
    """Enable the HTTP API and mint a bearer token for it.

    The frontend (and any external HTTP client) needs both `http.enabled` and
    a non-empty `http.token`. Default to enabling — `docket` on its own is a
    TUI, but the web UI is the expected graphical entry point."""
    console.print(
        "The HTTP API powers the web UI and any external clients. "
        "When enabled, a bearer token is required on every request."
    )
    state.http_enabled = Confirm.ask("Enable the HTTP API?", default=state.http_enabled)
    if not state.http_enabled:
        console.print("[dim]Skipped — `docket serve` will refuse to start until re-enabled.[/dim]")
        return
    if state.http_token and not Confirm.ask(
        "An HTTP token is already configured — generate a new one?", default=False
    ):
        console.print("[dim]Keeping the existing token.[/dim]")
    else:
        state.http_token = secrets.token_urlsafe(32)
        console.print(
            "[green]✓ generated a new bearer token[/green] "
            "[dim](stored in config.toml under http.token)[/dim]"
        )
    console.print(f"[dim]Bind:[/dim] {state.http_bind}  [dim]Port:[/dim] {state.http_port}")


# ---- step 8 ------------------------------------------------------------------


def _step_prompt_templates(state: WizardState) -> None:
    created = scaffold_prompts(state.paths.prompts_dir)
    if created:
        console.print(
            f"[green]✓ scaffolded {len(created)} template(s)[/green] at {state.paths.prompts_dir}"
        )
        for name in created:
            console.print(f"    {name}")
        console.print(
            "[dim]You can edit these later from the app with the prompt library (`p`) or by editing the files directly.[/dim]"
        )
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
        console.print("Running initial full sync...")
        summary = sync_service.full_refresh(
            conn,
            provider,
            "default",
            state.scope.to_core(),
            provider_key=_DEFAULT_PROVIDER_KEY,
        )
        console.print(
            f"[green]✓ synced {summary.upserted} item(s)[/green] "
            f"(archived {summary.archived}, watermark {summary.watermark})"
        )
    finally:
        conn.close()


# ---- provider subcommands ----------------------------------------------------


def provider_list() -> None:
    """Print the currently-configured providers."""
    paths = resolve_paths()
    if not paths.config_file.exists():
        console.print("[yellow]No config.toml yet — run `docket setup` first.[/yellow]")
        raise SystemExit(1)
    cfg = load_config(paths)
    if not cfg.providers:
        console.print("[yellow]No providers configured yet.[/yellow]")
        return
    for key, entry in cfg.providers.items():
        active = " (active)" if key == cfg.active_provider else ""
        console.print(
            f"[cyan]{key}[/cyan] · {entry.display_name} · [dim]{entry.type}[/dim]{active}"
        )
        for scope_name, _scope in entry.scopes.items():
            star = "*" if scope_name == entry.active_scope else " "
            console.print(f"  {star} {scope_name}")


def provider_add(
    name: str,
    type_id: str,
    *,
    display_name: str | None = None,
    make_active: bool = False,
) -> None:
    """Register a new provider entry. Per-type validation lives here so the
    registry can stay dumb — this is the single authoritative surface where
    the wizard-shaped config emerges."""
    from docket.providers.registry import types as registry_types

    paths = resolve_paths()
    paths.ensure()
    known = registry_types()
    if type_id not in known:
        console.print(f"[red]Unknown provider type '{type_id}'[/red] (known: {', '.join(known)}).")
        raise SystemExit(2)

    config: dict[str, object] = {}
    if type_id == "azure_devops":
        org = Prompt.ask("Azure DevOps organization URL").strip().rstrip("/")
        if not _looks_like_http_url(org):
            console.print("[red]Organization must be a full URL.[/red]")
            raise SystemExit(2)
        project = Prompt.ask("Project name").strip()
        if not project:
            console.print("[red]Project name is required.[/red]")
            raise SystemExit(2)
        config = {"organization": str(HttpUrl(org)), "project": project}
    elif type_id == "github":
        default_repo = _pick_github_repo()
        config = {"default_repo": default_repo}
    elif type_id == "github_stub":
        default_repo = Prompt.ask("Default repo (owner/name)", default="example/repo").strip()
        config = {"default_repo": default_repo}
    else:
        # Custom provider types (from entry points) self-validate via the
        # factory on first build; the wizard just records an empty config
        # so the user can hand-edit config.toml.
        console.print(
            f"[dim]No wizard prompts for '{type_id}' — config starts empty. "
            "Edit config.toml to fill it in.[/dim]"
        )

    cfg = _load_or_empty(paths)
    if name in cfg.providers and not Confirm.ask(
        f"Provider '{name}' already exists. Overwrite?", default=False
    ):
        return
    cfg.providers[name] = ProviderEntry(
        type=type_id,
        display_name=display_name or name,
        config=config,
        scopes={"default": ScopeFilter()},
        active_scope="default",
    )
    if make_active or not cfg.active_provider:
        cfg.active_provider = name
    save_config(paths, cfg)
    console.print(f"[green]✓ added provider '{name}'[/green]")


def _pick_github_repo() -> str:
    """Offer discovered repos for the active `gh` session, or fall back to typing.

    Composition:
      1. The authenticated user's own repos (`/user/repos`).
      2. Every org the user is a member of — via `/orgs/{org}/repos` so
         private repos they have access to show up too (not just the
         public ones `/users/{login}/repos` would return).

    We merge into a single de-duplicated picker ordered by discovery so
    "my repos first, then each org in turn" reads naturally. Any step's
    failure falls through to the remaining sources, and if nothing comes
    back we drop to the manual prompt so a user without `gh` (or a user
    in zero orgs and zero repos, somehow) can still finish."""
    from docket.providers.github import discover as gh_discover

    seen: set[str] = set()
    repos: list[str] = []

    def _add(refs: list[gh_discover.RepoRef]) -> None:
        for ref in refs:
            if ref.full_name not in seen:
                seen.add(ref.full_name)
                repos.append(ref.full_name)

    login = gh_discover.signed_in_login()
    if login:
        console.print(f"[dim]Scanning repos for [cyan]{login}[/cyan]...[/dim]")

    # Section 1: the user's own repos.
    try:
        _add(gh_discover.list_repos())
    except gh_discover.DiscoveryError as e:
        console.print(
            f"[dim]Couldn't list your personal repos via `gh` ({e}) — "
            "continuing with org discovery.[/dim]"
        )

    # Section 2: repos in every org the user belongs to. `gh` silently
    # returns an empty list when the user is in no orgs, so this is free.
    try:
        orgs = gh_discover.list_orgs()
    except gh_discover.DiscoveryError as e:
        console.print(f"[dim]Couldn't list orgs via `gh` ({e}).[/dim]")
        orgs = []
    for org in orgs:
        before = len(repos)
        try:
            _add(gh_discover.list_org_repos(org.login))
        except gh_discover.DiscoveryError as e:
            console.print(f"[dim]Skipping org [cyan]{org.login}[/cyan] ({e}).[/dim]")
            continue
        added = len(repos) - before
        console.print(f"[dim]  · [cyan]{org.login}[/cyan]: {added} repo(s)[/dim]")

    if not repos:
        return _prompt_github_repo_manual()

    choice = _pick("GitHub repository", repos, allow_custom=True)
    if choice is _CUSTOM_SENTINEL:
        return _prompt_github_repo_manual()
    assert isinstance(choice, int)
    return repos[choice]


def _prompt_github_repo_manual() -> str:
    while True:
        raw = Prompt.ask("Default repo (owner/name)", default="").strip()
        if "/" in raw and not raw.startswith("/") and not raw.endswith("/"):
            return raw
        console.print("[red]Please enter an owner/name pair, e.g. `anthropics/claude-code`.[/red]")


def provider_remove(name: str) -> None:
    paths = resolve_paths()
    if not paths.config_file.exists():
        console.print("[yellow]No config.toml yet — nothing to remove.[/yellow]")
        raise SystemExit(1)
    cfg = load_config(paths)
    if name not in cfg.providers:
        console.print(
            f"[red]Unknown provider '{name}' (have: {', '.join(sorted(cfg.providers))}).[/red]"
        )
        raise SystemExit(2)
    if not Confirm.ask(f"Remove provider '{name}'?", default=False):
        return
    del cfg.providers[name]
    if cfg.active_provider == name:
        cfg.active_provider = next(iter(cfg.providers), "")
    save_config(paths, cfg)
    console.print(f"[green]✓ removed provider '{name}'[/green]")


def _load_or_empty(paths: Paths) -> Config:
    if paths.config_file.exists():
        return load_config(paths)
    return Config()
