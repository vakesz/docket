"""First-launch setup wizard.

The wizard walks the user through picking a provider type, running that
provider's auth/connection/scope onboarding, filling in the shared host
surfaces (telemetry, HTTP), scaffolding prompts, and running a first sync.
Output shape: each backend is an entry under `providers`, with
`active_provider` pointing at whichever one should open by default.

`--step=<name>` jumps directly to a step and writes config atomically on
completion. Step names are provider-agnostic: provider, auth, connection,
scope, telemetry, http, llm, prompts, sync, default.

Auto-discovery: each provider's onboarding uses its CLI session (az/gh) to
populate numbered pickers so users rarely have to type values they could
click. Any discovery failure transparently falls back to free-form prompts
— helpful for restricted networks."""

from __future__ import annotations

import os
import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:
    from docket.providers.github.discover import HostRef

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
from docket.providers import registry
from docket.providers.azure_devops import AzureDevOpsProvider, discover
from docket.providers.azure_devops.auth import ensure_logged_in
from docket.providers.azure_devops.discover import DiscoveryError
from docket.providers.base import ProviderAuthError, ProviderError
from docket.storage import init_db

console = Console()

STEP_NAMES: tuple[str, ...] = (
    "provider",
    "auth",
    "connection",
    "label",
    "scope",
    "telemetry",
    "http",
    "llm",
    "prompts",
    "sync",
    "default",
)

_CUSTOM_SENTINEL = "__custom__"
_ANY_SENTINEL = "__any__"


@dataclass
class WizardState:
    paths: Paths
    existing: Config = field(default_factory=Config)
    # Set by the provider-selection step.
    type_id: str = ""
    provider_key: str = ""
    display_name: str = ""
    provider_config: dict[str, Any] = field(default_factory=dict)
    scope: ScopeFilter = field(default_factory=ScopeFilter)
    # Shared host surfaces. Inherited from existing config if present.
    telemetry_enabled: bool = True
    telemetry_level: str = "DEBUG"
    http_enabled: bool = True
    http_bind: str = "127.0.0.1"
    http_port: int = 8765
    http_token: str = ""
    llm_endpoint: str = ""
    llm_deployment: str = "gpt-5"
    # Discovered hints (used to pre-populate assignee pickers).
    signed_in_email: str | None = None
    # gh host picked during the GitHub connection step. Feeds the label
    # step's default and is not persisted directly (base_url is).
    signed_in_github_host: str | None = None
    # Whether this entry should become the active provider after saving.
    make_active: bool = True


def run_wizard(start_at: str | None = None) -> None:
    """Drive the wizard interactively. Writes config.toml atomically at the end."""
    paths = resolve_paths()
    paths.ensure()
    state = _load_existing_state(paths)

    console.print(
        Panel.fit(
            "[bold]Docket setup[/bold]\n"
            "This wizard adds or reconfigures a provider, prepares shared\n"
            "settings, scaffolds prompt templates, and runs an initial sync.\n"
            "You can exit at any time with Ctrl-C and resume with `docket setup`.",
            border_style="cyan",
        )
    )
    _print_existing_providers(state.existing)

    steps: list[tuple[str, Callable[[WizardState], None]]] = [
        ("provider", _step_pick_provider),
        ("auth", _step_provider_auth),
        ("connection", _step_provider_connection),
        ("label", _step_pick_label),
        ("scope", _step_provider_scope),
        ("telemetry", _step_telemetry),
        ("http", _step_http_surface),
        ("llm", _step_llm),
        ("prompts", _step_prompt_templates),
        ("sync", _step_initial_sync),
        ("default", _step_make_active),
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


def _print_existing_providers(cfg: Config) -> None:
    if not cfg.providers:
        return
    console.print("[bold]Existing providers:[/bold]")
    for key, entry in cfg.providers.items():
        marker = " [green](active)[/green]" if key == cfg.active_provider else ""
        console.print(
            f"  · [cyan]{key}[/cyan] — {entry.display_name} [dim]({entry.type})[/dim]{marker}"
        )


def _load_existing_state(paths: Paths) -> WizardState:
    state = WizardState(paths=paths)
    if not paths.config_file.exists():
        return state
    try:
        cfg = load_config(paths)
    except (ValidationError, Exception):
        return state
    state.existing = cfg
    state.telemetry_enabled = cfg.telemetry.enabled
    state.telemetry_level = cfg.telemetry.level
    state.http_enabled = cfg.http.enabled
    state.http_bind = cfg.http.bind
    state.http_port = cfg.http.port
    state.http_token = cfg.http.token
    state.llm_endpoint = str(cfg.llm.endpoint) if cfg.llm.endpoint else ""
    state.llm_deployment = cfg.llm.deployment
    key = cfg.active_provider or next(iter(cfg.providers), "")
    entry = cfg.providers.get(key) if key else None
    if entry is not None:
        state.provider_key = key
        state.type_id = entry.type
        state.display_name = entry.display_name
        state.provider_config = dict(entry.config)
        state.scope = entry.scopes.get(entry.active_scope) or entry.scopes.get(
            "default", ScopeFilter()
        )
    return state


# ---- step 1: provider selection ---------------------------------------------


def _step_pick_provider(state: WizardState) -> None:
    """Pick a provider type and a config key for it.

    When the user already has a provider entry of the chosen type, we offer a
    fresh sibling id by default so additions don't silently overwrite. Reusing
    an existing id prompts for explicit confirmation before we clobber it."""
    specs = registry.specs()
    if not specs:
        console.print("[red]No provider types registered.[/red]")
        raise SystemExit(2)
    labels = [f"{s.display_name} ({s.type_id})" for s in specs]
    choice = _pick("Provider type", labels)
    assert isinstance(choice, int)
    spec = specs[choice]
    state.type_id = spec.type_id
    state.display_name = spec.display_name

    existing_keys = set(state.existing.providers)
    if spec.type_id not in existing_keys:
        state.provider_key = spec.type_id
        state.provider_config = {}
        state.scope = ScopeFilter()
        return

    default_key = _next_sibling_key(spec.type_id, existing_keys)
    console.print(
        f"[dim]A provider of type '{spec.type_id}' is already configured. "
        f"Choose a new id to add another, or reuse an existing id to reconfigure it.[/dim]"
    )
    raw = Prompt.ask("Config key for this provider", default=default_key).strip()
    key = raw or default_key
    if key in existing_keys:
        existing_entry = state.existing.providers[key]
        if not Confirm.ask(
            f"Reconfigure existing provider '{key}' ({existing_entry.type})?",
            default=False,
        ):
            raise SystemExit(1)
        # Carry display_name / scope forward so unchanged values survive.
        state.display_name = existing_entry.display_name
        state.provider_config = dict(existing_entry.config)
        state.scope = existing_entry.scopes.get(existing_entry.active_scope, ScopeFilter())
    else:
        state.provider_config = {}
        state.scope = ScopeFilter()
    state.provider_key = key


def _next_sibling_key(type_id: str, taken: set[str]) -> str:
    i = 2
    while f"{type_id}-{i}" in taken:
        i += 1
    return f"{type_id}-{i}"


# ---- step 2: auth (per-provider) --------------------------------------------


def _step_provider_auth(state: WizardState) -> None:
    if state.type_id == "azure_devops":
        _azure_devops_step_auth(state)
    elif state.type_id == "github":
        _github_step_auth(state)
    elif state.type_id == "github_stub":
        console.print("[dim]No auth needed — github_stub runs entirely in-memory.[/dim]")
    else:
        console.print(
            f"[dim]No built-in auth step for '{state.type_id}'. "
            "The provider factory will surface auth errors on first sync.[/dim]"
        )


def _azure_devops_step_auth(state: WizardState) -> None:
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


def _github_step_auth(state: WizardState) -> None:
    from docket.providers.github.auth import (
        ensure_logged_in as gh_ensure_logged_in,
    )
    from docket.providers.github.auth import (
        signed_in_email as gh_signed_in_email,
    )

    console.print("Checking GitHub CLI session...")
    while True:
        try:
            login = gh_ensure_logged_in()
        except ProviderAuthError as e:
            console.print(f"[yellow]{e}[/yellow]")
            if not Confirm.ask("Retry now?", default=True):
                raise SystemExit(1) from e
            continue
        console.print(f"[green]✓ signed in as[/green] {login}")
        state.signed_in_email = gh_signed_in_email()
        return


# ---- step 3: connection (per-provider) --------------------------------------


def _step_provider_connection(state: WizardState) -> None:
    if state.type_id == "azure_devops":
        _azure_devops_step_connection(state)
    elif state.type_id == "github":
        _github_step_connection(state)
    elif state.type_id == "github_stub":
        _github_stub_step_connection(state)
    else:
        _generic_step_connection(state)


def _azure_devops_step_connection(state: WizardState) -> None:
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
    current = str(state.provider_config.get("project", ""))
    while True:
        project = Prompt.ask("Project name", default=current or "").strip()
        if project:
            return project
        console.print("[red]Project name is required.[/red]")


def _github_step_connection(state: WizardState) -> None:
    host = _pick_github_host()
    repo = _pick_github_repo(host=host.hostname if host else None)
    config: dict[str, Any] = {"default_repo": repo}
    if host and host.api_base_url != "https://api.github.com":
        config["base_url"] = host.api_base_url
    state.provider_config = config
    # Store the hostname as a hint for the label step's default — doesn't
    # persist to config.toml; only `base_url` / `default_repo` do.
    state.signed_in_github_host = host.hostname if host else None


def _pick_github_host() -> HostRef | None:
    """Offer every authenticated gh host, plus a custom-URL escape hatch.

    Returns `None` only when the user has a single github.com host and we
    don't need to disambiguate — callers treat that as "use the default
    `api.github.com` base URL and the default `gh` host."""
    from docket.providers.github import discover as gh_discover

    hosts = gh_discover.list_hosts()
    if not hosts:
        # `gh auth status --json hosts` failed — assume github.com and move
        # on; repo discovery will surface the real problem if there is one.
        return None
    if len(hosts) == 1 and hosts[0].hostname == "github.com":
        return hosts[0]

    console.print(
        "[dim]Multiple GitHub hosts are signed in via `gh`. "
        "Pick which one this provider should use.[/dim]"
    )
    labels = [f"{h.hostname}  [dim]→ {h.api_base_url}[/dim]" for h in hosts]
    choice = _pick("GitHub host", labels, allow_custom=True)
    if choice is _CUSTOM_SENTINEL:
        return _prompt_github_host_manual()
    assert isinstance(choice, int)
    return hosts[choice]


def _prompt_github_host_manual() -> HostRef:
    from docket.providers.github.discover import HostRef

    while True:
        raw = (
            Prompt.ask(
                "GitHub host (e.g. github.com or ghe.example.com)",
                default="github.com",
            )
            .strip()
            .lower()
        )
        if not raw or " " in raw or "/" in raw:
            console.print("[red]Please enter a bare hostname, e.g. `ghe.example.com`.[/red]")
            continue
        if raw == "github.com":
            return HostRef(hostname=raw, api_base_url="https://api.github.com")
        return HostRef(hostname=raw, api_base_url=f"https://{raw}/api/v3")


def _github_stub_step_connection(state: WizardState) -> None:
    current = str(state.provider_config.get("default_repo", "example/repo"))
    repo = Prompt.ask("Default repo (owner/name)", default=current).strip() or current
    state.provider_config = {"default_repo": repo}


def _generic_step_connection(state: WizardState) -> None:
    """Prompt raw config fields declared by a third-party provider spec."""
    spec = registry.spec(state.type_id)
    if spec is None or not spec.setup_fields:
        console.print(f"[dim]No connection fields declared for '{state.type_id}'.[/dim]")
        return
    config: dict[str, Any] = {}
    for setup_field in spec.setup_fields:
        prompt_label = setup_field.label + ("" if setup_field.required else " (optional)")
        current = str(state.provider_config.get(setup_field.key, ""))
        default = current or setup_field.placeholder
        while True:
            raw = Prompt.ask(prompt_label, default=default).strip()
            if setup_field.required and not raw:
                console.print(f"[red]{setup_field.label} is required.[/red]")
                continue
            if setup_field.kind == "url" and raw and not _looks_like_http_url(raw):
                console.print("[red]Must be a full URL (http or https).[/red]")
                continue
            config[setup_field.key] = raw
            break
    state.provider_config = config


def _looks_like_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


# ---- step 3b: label (per-provider) ------------------------------------------


def _step_pick_label(state: WizardState) -> None:
    """Prompt for the human-readable display name shown in the TUI/web switcher.

    Without this step every GitHub entry defaults to the spec's "GitHub"
    label, which makes three github entries indistinguishable in the
    provider dropdown. We default to a repo/org-aware suggestion so the
    common case is just pressing enter."""
    default = _suggest_display_name(state)
    collisions = {
        key: entry.display_name
        for key, entry in state.existing.providers.items()
        if key != state.provider_key and entry.display_name == default
    }
    if collisions:
        console.print(
            "[yellow]Heads up:[/yellow] another provider "
            f"([cyan]{next(iter(collisions))}[/cyan]) already uses "
            f"[cyan]{default}[/cyan] as its label. "
            "Pick something distinct so the TUI/web switcher is unambiguous."
        )
    else:
        console.print("Label for this provider — shown in the TUI and web provider switcher.")

    while True:
        raw = Prompt.ask("Display name", default=default).strip() or default
        clashes = [
            key
            for key, entry in state.existing.providers.items()
            if key != state.provider_key and entry.display_name == raw
        ]
        if clashes and not Confirm.ask(
            f"[yellow]'{raw}' is already in use by '{clashes[0]}'. Use anyway?[/yellow]",
            default=False,
        ):
            continue
        state.display_name = raw
        return


def _suggest_display_name(state: WizardState) -> str:
    """Build a sensible default label from the provider config we've collected."""
    if state.type_id == "azure_devops":
        org_url = str(state.provider_config.get("organization", ""))
        project = str(state.provider_config.get("project", ""))
        org = urlparse(org_url).path.strip("/") or urlparse(org_url).netloc
        if org and project:
            return f"Azure DevOps · {org}/{project}"
        if state.display_name:
            return state.display_name
        return "Azure DevOps"
    if state.type_id in ("github", "github_stub"):
        repo = str(state.provider_config.get("default_repo", ""))
        host = state.signed_in_github_host
        prefix = "GitHub"
        if host and host != "github.com":
            # Surface the host so "GitHub · foo/bar" on github.com and
            # "ghe.example.com · foo/bar" on Enterprise don't collide.
            prefix = host
        if repo:
            return f"{prefix} · {repo}"
        return prefix
    return state.display_name or state.type_id


# ---- step 4: scope (per-provider) -------------------------------------------


def _step_provider_scope(state: WizardState) -> None:
    if state.type_id == "azure_devops":
        _azure_devops_step_scope(state)
    elif state.type_id in ("github", "github_stub"):
        _github_step_scope(state)
    else:
        state.scope = ScopeFilter()


def _azure_devops_step_scope(state: WizardState) -> None:
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
        assignee = _pick_assignee(state)
        scope = ScopeFilter(
            team=team,
            area_path=area,
            iteration_path=iteration,
            assignee=assignee,
        )

        count = _count_azure_devops_items_for_scope(org, project, scope)
        if count is None:
            console.print("[yellow]Could not count items — proceeding with this scope.[/yellow]")
        else:
            console.print(f"[cyan]→ {count} item(s) match this scope[/cyan]")

        if Confirm.ask("Use this scope?", default=True):
            state.scope = scope
            return


def _github_step_scope(state: WizardState) -> None:
    """GitHub scope is just the assignee — team/area/iteration don't apply."""
    console.print(
        "Scope filters limit which issues/PRs get cached locally. "
        "Only 'assignee' is meaningful for GitHub."
    )
    assignee = _pick_assignee(state)
    state.scope = ScopeFilter(assignee=assignee)


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

    choice = _pick(label, options, allow_any=True, allow_custom=True)
    if choice is _ANY_SENTINEL:
        return ""
    if choice is _CUSTOM_SENTINEL:
        raw = Prompt.ask(f"{label} (free-form)", default=current or "")
        return raw.strip()
    assert isinstance(choice, int)
    return options[choice]


def _pick_assignee(state: WizardState) -> str:
    """Offer any, @me, the detected email, and custom. Returns '' for 'any'.

    'any' is the default — defaulting to @me silently filters to the user's
    assigned items, which looks like a broken sync on third-party repos where
    they aren't a maintainer."""
    options: list[str] = ["@me"]
    if state.signed_in_email and state.signed_in_email not in options:
        options.append(state.signed_in_email)
    choice = _pick("Assignee", options, allow_any=True, allow_custom=True)
    if choice is _ANY_SENTINEL:
        return ""
    if choice is _CUSTOM_SENTINEL:
        current = state.scope.assignee
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
    """Render a numbered chooser. Returns an int index or a sentinel ('any' / 'custom').

    When `allow_any` is set, 'any' is rendered as option 1 and is the default
    on enter — prior callers defaulted to the first discovered option, which
    silently narrowed the scope in ways users rarely wanted."""
    console.print(f"[bold]{label}:[/bold]")
    any_key: str | None = None
    if allow_any:
        any_key = "1"
        console.print(f"  [cyan]{any_key}[/cyan]. any")
    offset = 1 if allow_any else 0
    for i, opt in enumerate(options, start=1 + offset):
        console.print(f"  [cyan]{i}[/cyan]. {opt}")
    custom_key: str | None = None
    if allow_custom:
        custom_key = str(len(options) + 1 + offset)
        console.print(f"  [cyan]{custom_key}[/cyan]. custom…")
    valid_numeric = [str(i) for i in range(1, len(options) + 1 + offset)]
    if custom_key is not None:
        valid_numeric.append(custom_key)
    default = any_key or "1"
    raw = Prompt.ask("Choose", choices=valid_numeric, default=default, show_choices=False)
    if any_key is not None and raw == any_key:
        return _ANY_SENTINEL
    if custom_key is not None and raw == custom_key:
        return _CUSTOM_SENTINEL
    return int(raw) - 1 - offset


def _count_azure_devops_items_for_scope(org: str, project: str, scope: ScopeFilter) -> int | None:
    try:
        provider = AzureDevOpsProvider(organization_url=org, project=project)
        items = list(provider.list_changes_since(None, scope.to_core()))
        return len(items)
    except ProviderError:
        return None


# ---- step 5: telemetry ------------------------------------------------------


def _step_telemetry(state: WizardState) -> None:
    console.print(
        f"Local structured logs and the token/cost ledger land at [cyan]{state.paths.cache_dir}[/cyan].\n"
        "Nothing is shipped off-device. You can change this later from the in-app settings screen or config.toml."
    )
    state.telemetry_enabled = Confirm.ask("Keep local telemetry enabled?", default=True)
    if state.telemetry_enabled:
        # DEBUG is intentional: the on-disk JSON log is the only place worker
        # tracebacks surface during a TUI session, and a small group of
        # operators reviews it. Drop to INFO if log volume becomes a problem.
        levels = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]
        default = state.telemetry_level if state.telemetry_level in levels else "DEBUG"
        chosen = Prompt.ask(
            "Log level (DEBUG keeps everything; raise to reduce volume)",
            choices=levels,
            default=default,
        )
        state.telemetry_level = chosen


# ---- step 6: HTTP surface ---------------------------------------------------


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
    env_token = os.environ.get("DOCKET_API_TOKEN", "").strip()
    if state.http_token and not Confirm.ask(
        "An HTTP token is already configured — generate a new one?", default=False
    ):
        console.print("[dim]Keeping the existing token.[/dim]")
    elif env_token:
        state.http_token = env_token
        console.print(
            "[green]✓ using DOCKET_API_TOKEN from environment[/green] "
            "[dim](mirrored into config.toml under http.token — keeps the frontend proxy in sync)[/dim]"
        )
    else:
        state.http_token = secrets.token_urlsafe(32)
        console.print(
            "[green]✓ generated a new bearer token[/green] "
            "[dim](stored in config.toml under http.token)[/dim]"
        )
    console.print(f"[dim]Bind:[/dim] {state.http_bind}  [dim]Port:[/dim] {state.http_port}")


# ---- step 7: llm ------------------------------------------------------------


def _step_llm(state: WizardState) -> None:
    """Capture Azure OpenAI endpoint + deployment for config.toml's `[llm]`.

    The API key has no config.toml home and stays in `.env`; we surface its
    presence so the user knows whether chat will actually start after setup.
    Leaving the endpoint blank disables chat — `/conversation` endpoints will
    return 503 until a value is set (via this step or `AZURE_OPENAI_ENDPOINT`
    in `.env`, which overrides config.toml at runtime)."""
    env_endpoint = os.environ.get("AZURE_OPENAI_ENDPOINT", "").strip()
    env_deployment = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "").strip()
    console.print(
        "Chat / suggestions use an Azure OpenAI deployment. Endpoint + deployment "
        "persist to config.toml; the API key stays in .env (no config.toml home). "
        "Leave the endpoint blank to disable chat."
    )

    endpoint_default = state.llm_endpoint or env_endpoint
    if env_endpoint and not state.llm_endpoint:
        console.print("[dim]Pre-filled from AZURE_OPENAI_ENDPOINT.[/dim]")
    while True:
        raw = Prompt.ask(
            "Azure OpenAI endpoint URL (blank to disable chat)",
            default=endpoint_default,
        ).strip()
        if not raw:
            state.llm_endpoint = ""
            console.print("[dim]Skipped — /conversation endpoints will return 503.[/dim]")
            return
        try:
            HttpUrl(raw)
        except ValidationError:
            console.print("[red]Not a valid URL — try again.[/red]")
            continue
        state.llm_endpoint = raw
        break

    deployment_default = state.llm_deployment or env_deployment or "gpt-5"
    state.llm_deployment = (
        Prompt.ask("Deployment name", default=deployment_default).strip() or deployment_default
    )

    if os.environ.get("AZURE_OPENAI_API_KEY", "").strip():
        console.print("[green]✓ AZURE_OPENAI_API_KEY detected in the environment.[/green]")
    else:
        console.print(
            "[yellow]Heads up[/yellow]: AZURE_OPENAI_API_KEY is not set. "
            "Add it to your .env before `docket serve` to enable chat."
        )


# ---- step 8: prompts --------------------------------------------------------


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


# ---- step 9: initial sync ---------------------------------------------------


def _step_initial_sync(state: WizardState) -> None:
    console.print(f"Initializing database at [cyan]{state.paths.db_file}[/cyan]...")
    conn = init_db(state.paths.db_file)
    try:
        provider = registry.build(
            state.type_id,
            state.provider_config,
            display_name=state.display_name,
        )
        console.print("Running initial full sync...")
        summary = sync_service.full_refresh(
            conn,
            provider,
            provider_key=state.provider_key,
        )
        console.print(
            f"[green]✓ synced {summary.upserted} item(s)[/green] "
            f"(archived {summary.archived}, watermark {summary.watermark})"
        )
    finally:
        conn.close()


# ---- step 10: default provider ----------------------------------------------


def _step_make_active(state: WizardState) -> None:
    """Decide whether this entry becomes the active provider.

    Auto-active when there are no siblings or nothing is currently active.
    Otherwise ask — users adding a second/third provider rarely want it to
    silently take over the TUI's default."""
    siblings = [k for k in state.existing.providers if k != state.provider_key]
    current = state.existing.active_provider
    if not siblings or not current or current == state.provider_key:
        state.make_active = True
        return
    state.make_active = Confirm.ask(
        f"Make '{state.provider_key}' the active provider? (currently: {current})",
        default=False,
    )


# ---- build & persist --------------------------------------------------------


def _build_config_from_state(state: WizardState) -> Config:
    """Compose the Config object by layering the new provider entry onto
    whatever was loaded. Non-wizard fields (ui, sync, stale) survive
    untouched so partial runs with `--step=<name>` don't clobber them;
    the llm step rewrites only endpoint + deployment, leaving advanced
    knobs (compaction threshold, watch interval) alone."""
    providers = dict(state.existing.providers)
    existing_entry = providers.get(state.provider_key)
    scopes = dict(existing_entry.scopes) if existing_entry else {}
    scopes["default"] = state.scope
    providers[state.provider_key] = ProviderEntry(
        type=state.type_id,
        display_name=state.display_name,
        config=state.provider_config,
        scopes=scopes,
        active_scope=existing_entry.active_scope if existing_entry else "default",
    )
    active_provider = state.existing.active_provider
    if state.make_active or not active_provider:
        active_provider = state.provider_key
    return state.existing.model_copy(
        update={
            "providers": providers,
            "active_provider": active_provider,
            "telemetry": TelemetryConfig(
                enabled=state.telemetry_enabled,
                level=state.telemetry_level,
            ),
            "http": HttpConfig(
                enabled=state.http_enabled,
                bind=state.http_bind,
                port=state.http_port,
                token=state.http_token,
            ),
            "llm": state.existing.llm.model_copy(
                update={
                    "endpoint": HttpUrl(state.llm_endpoint) if state.llm_endpoint else None,
                    "deployment": state.llm_deployment,
                }
            ),
        }
    )


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
    label_hint = ""
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
        org_slug = (
            urlparse(str(config["organization"])).path.strip("/")
            or urlparse(str(config["organization"])).netloc
        )
        label_hint = (
            f"Azure DevOps · {org_slug}/{project}" if org_slug else f"Azure DevOps · {project}"
        )
    elif type_id == "github":
        host = _pick_github_host()
        default_repo = _pick_github_repo(host=host.hostname if host else None)
        config = {"default_repo": default_repo}
        if host and host.api_base_url != "https://api.github.com":
            config["base_url"] = host.api_base_url
        prefix = host.hostname if host and host.hostname != "github.com" else "GitHub"
        label_hint = f"{prefix} · {default_repo}"
    elif type_id == "github_stub":
        default_repo = Prompt.ask("Default repo (owner/name)", default="example/repo").strip()
        config = {"default_repo": default_repo}
        label_hint = f"GitHub (stub) · {default_repo}"
    else:
        # Custom provider types (from entry points) self-validate via the
        # factory on first build; the wizard just records an empty config
        # so the user can hand-edit config.toml.
        console.print(
            f"[dim]No wizard prompts for '{type_id}' — config starts empty. "
            "Edit config.toml to fill it in.[/dim]"
        )

    cfg = load_config(paths) if paths.config_file.exists() else Config()
    if name in cfg.providers and not Confirm.ask(
        f"Provider '{name}' already exists. Overwrite?", default=False
    ):
        return

    if display_name is None:
        default_label = label_hint or name
        console.print(
            "Label for this provider — shown in the TUI and web provider switcher. "
            "Press enter to accept the suggested default."
        )
        display_name = Prompt.ask("Display name", default=default_label).strip() or default_label

    cfg.providers[name] = ProviderEntry(
        type=type_id,
        display_name=display_name,
        config=config,
        scopes={"default": ScopeFilter()},
        active_scope="default",
    )
    if make_active or not cfg.active_provider:
        cfg.active_provider = name
    save_config(paths, cfg)
    console.print(f"[green]✓ added provider '{name}'[/green] as [cyan]{display_name}[/cyan]")


def _pick_github_repo(*, host: str | None = None) -> str:
    """Offer discovered repos for the active `gh` session, or fall back to typing.

    Composition:
      1. The authenticated user's own repos (`/user/repos`).
      2. Every org the user is a member of — via `/orgs/{org}/repos` so
         private repos they have access to show up too (not just the
         public ones `/users/{login}/repos` would return).

    We merge into a single de-duplicated picker ordered by discovery so
    "my repos first, then each org in turn" reads naturally. The custom
    option lets the user type any repo they can read — including
    open-source repos they don't own (e.g. `ericsson/codechecker`). Any
    discovery failure falls through to the remaining sources, and if
    nothing comes back we drop to the manual prompt so a user without
    `gh` (or in zero orgs and zero repos) can still finish."""
    from docket.providers.github import discover as gh_discover

    seen: set[str] = set()
    repos: list[str] = []

    def _add(refs: list[gh_discover.RepoRef]) -> None:
        for ref in refs:
            if ref.full_name not in seen:
                seen.add(ref.full_name)
                repos.append(ref.full_name)

    login = gh_discover.signed_in_login(host=host)
    host_label = host or "github.com"
    if login:
        console.print(
            f"[dim]Scanning repos on [cyan]{host_label}[/cyan] for [cyan]{login}[/cyan]...[/dim]"
        )

    discovery_errors: list[str] = []

    # Section 1: the user's own repos.
    try:
        _add(gh_discover.list_repos(host=host))
    except gh_discover.DiscoveryError as e:
        discovery_errors.append(f"personal repos: {e}")

    # Section 2: repos in every org the user belongs to. `gh` silently
    # returns an empty list when the user is in no orgs, so this is free.
    try:
        orgs = gh_discover.list_orgs(host=host)
    except gh_discover.DiscoveryError as e:
        discovery_errors.append(f"orgs: {e}")
        orgs = []
    for org in orgs:
        before = len(repos)
        try:
            _add(gh_discover.list_org_repos(org.login, host=host))
        except gh_discover.DiscoveryError as e:
            console.print(f"[yellow]Skipping org [cyan]{org.login}[/cyan]:[/yellow] {e}")
            continue
        added = len(repos) - before
        console.print(f"[dim]  · [cyan]{org.login}[/cyan]: {added} repo(s)[/dim]")

    if discovery_errors:
        # Make failures loud, not dim — if we end up at the manual prompt
        # below, the user needs to know why discovery returned nothing.
        for detail in discovery_errors:
            console.print(f"[yellow]GitHub discovery issue ({detail})[/yellow]")

    if not repos:
        console.print(
            "[yellow]No repositories discovered.[/yellow] "
            "You can still type any repo you have read access to below "
            "(including public repos you don't own, e.g. "
            "[cyan]ericsson/codechecker[/cyan])."
        )
        return _prompt_github_repo_manual()

    console.print(
        "[dim]Don't see the repo you want? Choose [cyan]custom…[/cyan] to type "
        "any repo you can read (e.g. [cyan]ericsson/codechecker[/cyan]).[/dim]"
    )
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
