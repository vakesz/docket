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
— helpful for restricted networks.

Provider-specific onboarding lives in a small registry: each built-in
provider declares a `ProviderWizard` with optional `auth`, `connection`, and
`scope` callables. Unknown / third-party providers fall through to the
spec-driven generic connection step and a no-op scope."""

from __future__ import annotations

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import HttpUrl, ValidationError
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from docket.agent.prompt import scaffold as scaffold_prompts
from docket.config.loader import load_config, save_config
from docket.config.models import (
    Config,
    KeyHintConfig,
    ScopeFilter,
    TelemetryLevel,
    build_provider_entry,
    compose_setup_config,
)
from docket.config.paths import Paths, resolve_paths
from docket.config.secrets import (
    get_llm_api_key,
    keyring_available,
    make_hint,
    set_llm_api_key,
)
from docket.config.setup_utils import (
    build_label_suggestion,
    console,
    looks_like_http_url,
    pick,
    pick_assignee,
    pick_github_host,
    pick_github_repo,
    step_auth_with_retry,
)
from docket.core.services import sync_service
from docket.providers import registry
from docket.providers.azure_devops import AzureDevOpsProvider, discover
from docket.providers.azure_devops.auth import ensure_logged_in
from docket.providers.azure_devops.discover import DiscoveryError
from docket.providers.base import ProviderError
from docket.providers.github.auth import ensure_logged_in as gh_ensure_logged_in
from docket.providers.github.auth import signed_in_email as gh_signed_in_email
from docket.storage import init_db


@dataclass(frozen=True)
class ProviderWizard:
    """Per-provider onboarding hooks.

    Any of `auth`, `connection`, `scope` may be `None`; the orchestrator
    falls through to a sensible default in that case (a short "no auth
    needed" message for auth, spec-driven prompts for connection, and an
    empty `ScopeFilter` for scope)."""

    auth: Callable[[WizardState], None] | None = None
    connection: Callable[[WizardState], None] | None = None
    scope: Callable[[WizardState], None] | None = None


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


# Per-1M-token Azure Foundry list prices for known deployments. The wizard uses
# these as price-prompt defaults when the user keeps the suggested deployment
# name and hasn't already set explicit prices in config.toml. Update when
# Microsoft publishes new rates (https://azure.microsoft.com/pricing/details/ai-foundry-models/).
KNOWN_MODEL_PRICES: dict[str, tuple[float, float]] = {
    "gpt-5": (1.25, 10.0),
    "gpt-5-mini": (0.25, 2.0),
    "gpt-5-nano": (0.05, 0.4),
}


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
    telemetry_level: TelemetryLevel = TelemetryLevel.DEBUG
    http_enabled: bool = True
    http_bind: str = "127.0.0.1"
    http_port: int = 8765
    http_token: str = ""
    llm_endpoint: str = ""
    llm_deployment: str = "gpt-5"
    llm_price_input_per_1m: float | None = None
    llm_price_output_per_1m: float | None = None
    # Captured by the `llm` step and consumed by `_build_config_from_state`
    # to update `[llm.key_hint]` in config.toml. The key itself goes straight
    # to the OS keyring at the moment it's prompted; only the hint stays here.
    llm_key_hint: KeyHintConfig | None = None
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
    try:
        cfg = load_config(paths, optional=True)
    except ValidationError as e:
        console.print(
            f"[yellow]Existing config at {paths.config_file} is malformed "
            f"({e.error_count()} issues); starting the wizard fresh.[/yellow]"
        )
        return state
    if cfg is None:
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
    state.llm_price_input_per_1m = cfg.llm.price_input_per_1m
    state.llm_price_output_per_1m = cfg.llm.price_output_per_1m
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
    spec = specs[pick("Provider type", labels)]
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


def _azure_devops_step_auth(state: WizardState) -> None:
    step_auth_with_retry(ensure_logged_in, service_label="Azure CLI")
    state.signed_in_email = discover.signed_in_email()


def _github_step_auth(state: WizardState) -> None:
    step_auth_with_retry(gh_ensure_logged_in, service_label="GitHub CLI")
    state.signed_in_email = gh_signed_in_email()


def _github_stub_step_auth(state: WizardState) -> None:
    console.print("[dim]No auth needed — github_stub runs entirely in-memory.[/dim]")


def _step_provider_auth(state: WizardState) -> None:
    wiz = _WIZARDS.get(state.type_id)
    if wiz and wiz.auth is not None:
        wiz.auth(state)
        return
    console.print(
        f"[dim]No built-in auth step for '{state.type_id}'. "
        "The provider factory will surface auth errors on first sync.[/dim]"
    )


# ---- step 3: connection (per-provider) --------------------------------------


def _azure_devops_step_connection(state: WizardState) -> None:
    """Pick org and project — from discovery when available, manual otherwise."""
    while True:
        org = _azure_devops_pick_org(state)
        project = _azure_devops_pick_project(state, org)
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


def _azure_devops_pick_org(state: WizardState) -> str:
    try:
        orgs = discover.list_orgs()
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list organizations ({e}) — entering manually.[/dim]")
        orgs = []
    if not orgs:
        return _azure_devops_prompt_org_url(state)
    labels = [f"{o.name} ({o.url})" for o in orgs]
    match pick("Azure DevOps organization", labels, allow_custom=True):
        case "__custom__":
            return _azure_devops_prompt_org_url(state)
        case int(idx):
            return orgs[idx].url


def _azure_devops_prompt_org_url(state: WizardState) -> str:
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


def _azure_devops_pick_project(state: WizardState, org_url: str) -> str:
    try:
        projects = discover.list_projects(org_url)
    except DiscoveryError as e:
        console.print(f"[dim]Couldn't auto-list projects ({e}) — entering manually.[/dim]")
        projects = []
    if not projects:
        return _azure_devops_prompt_project_name(state)
    labels = [p.name for p in projects]
    match pick("Project", labels, allow_custom=True):
        case "__custom__":
            return _azure_devops_prompt_project_name(state)
        case int(idx):
            return projects[idx].name


def _azure_devops_prompt_project_name(state: WizardState) -> str:
    current = str(state.provider_config.get("project", ""))
    while True:
        project = Prompt.ask("Project name", default=current or "").strip()
        if project:
            return project
        console.print("[red]Project name is required.[/red]")


def _github_step_connection(state: WizardState) -> None:
    host = pick_github_host()
    repo = pick_github_repo(host=host.hostname if host else None)
    config: dict[str, Any] = {"default_repo": repo}
    if host and host.api_base_url != "https://api.github.com":
        config["base_url"] = host.api_base_url
    state.provider_config = config
    # Store the hostname as a hint for the label step's default — doesn't
    # persist to config.toml; only `base_url` / `default_repo` do.
    state.signed_in_github_host = host.hostname if host else None


def _github_stub_step_connection(state: WizardState) -> None:
    current = str(state.provider_config.get("default_repo", "example/repo"))
    repo = Prompt.ask("Default repo (owner/name)", default=current).strip() or current
    state.provider_config = {"default_repo": repo}


def _step_provider_connection(state: WizardState) -> None:
    wiz = _WIZARDS.get(state.type_id)
    if wiz and wiz.connection is not None:
        wiz.connection(state)
        return
    _generic_step_connection(state)


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
            if setup_field.kind == "url" and raw and not looks_like_http_url(raw):
                console.print("[red]Must be a full URL (http or https).[/red]")
                continue
            config[setup_field.key] = raw
            break
    state.provider_config = config


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
    """Build a sensible default label from the provider config we've collected.

    Delegates to `build_label_suggestion` so the wizard and
    `docket setup provider add` offer identical defaults. Falls back to the
    user's existing `state.display_name` (or the raw `type_id`) when the
    provider type isn't built-in and no label can be inferred."""
    suggested = build_label_suggestion(
        type_id=state.type_id,
        config=state.provider_config,
        github_host_hint=state.signed_in_github_host or "",
    )
    return suggested or state.display_name or state.type_id


# ---- step 4: scope (per-provider) -------------------------------------------


def _azure_devops_step_scope(state: WizardState) -> None:
    org = str(state.provider_config.get("organization", ""))
    project = str(state.provider_config.get("project", ""))
    console.print(
        "Scope filters limit which work items get cached locally. "
        "Leave any axis as 'any' to include everything."
    )
    while True:
        team = _azure_devops_pick_optional(
            "Team",
            fetch=lambda: discover.list_teams(org, project),
            current=state.scope.team,
        )
        area = _azure_devops_pick_optional(
            "Area path",
            fetch=lambda: discover.list_area_paths(org, project),
            current=state.scope.area_path,
        )
        iteration = _azure_devops_pick_optional(
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

        count = _azure_devops_count_items_for_scope(org, project, scope)
        if count is None:
            console.print("[yellow]Could not count items — proceeding with this scope.[/yellow]")
        else:
            console.print(f"[cyan]→ {count} item(s) match this scope[/cyan]")

        if Confirm.ask("Use this scope?", default=True):
            state.scope = scope
            return


def _azure_devops_pick_optional(
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


def _azure_devops_count_items_for_scope(org: str, project: str, scope: ScopeFilter) -> int | None:
    try:
        provider = AzureDevOpsProvider(organization_url=org, project=project)
        items = list(provider.list_changes_since(None, scope.to_core()))
        return len(items)
    except ProviderError:
        return None


def _github_step_scope(state: WizardState) -> None:
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


# Built-in provider onboarding hooks. Third-party providers either register
# their own entry here at import time or fall through to the generic spec-
# driven connection step + empty scope.
_WIZARDS: dict[str, ProviderWizard] = {
    "azure_devops": ProviderWizard(
        auth=_azure_devops_step_auth,
        connection=_azure_devops_step_connection,
        scope=_azure_devops_step_scope,
    ),
    "github": ProviderWizard(
        auth=_github_step_auth,
        connection=_github_step_connection,
        scope=_github_step_scope,
    ),
    "github_stub": ProviderWizard(
        auth=_github_stub_step_auth,
        connection=_github_stub_step_connection,
        scope=_github_step_scope,
    ),
}


def _step_provider_scope(state: WizardState) -> None:
    wiz = _WIZARDS.get(state.type_id)
    if wiz and wiz.scope is not None:
        wiz.scope(state)
        return
    state.scope = ScopeFilter()


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
        levels = [lvl.value for lvl in TelemetryLevel]
        chosen = Prompt.ask(
            "Log level (DEBUG keeps everything; raise to reduce volume)",
            choices=levels,
            default=state.telemetry_level.value,
        )
        state.telemetry_level = TelemetryLevel(chosen)


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


# ---- step 7: llm ------------------------------------------------------------


def _step_llm(state: WizardState) -> None:
    """Capture Azure OpenAI endpoint + deployment for config.toml's `[llm]`,
    and the API key into the OS keyring.

    Leaving the endpoint blank disables chat — `/conversation` endpoints
    return 503 until a value is set. The API key never lives in
    `config.toml`; we store it in the OS keyring (Keychain / Credential
    Manager / Secret Service) and write a non-secret hint into
    `[llm.key_hint]` so the UI can show the user which key is loaded."""
    console.print(
        "Chat / suggestions use an Azure OpenAI deployment. Endpoint + deployment "
        "persist to config.toml; the API key is stored in your OS keyring. "
        "Leave the endpoint blank to disable chat."
    )

    endpoint_default = state.llm_endpoint
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

    deployment_default = state.llm_deployment or "gpt-5"
    state.llm_deployment = (
        Prompt.ask("Deployment name", default=deployment_default).strip() or deployment_default
    )

    known = KNOWN_MODEL_PRICES.get(state.llm_deployment.lower())
    price_input_default = state.llm_price_input_per_1m
    price_output_default = state.llm_price_output_per_1m
    if known is not None:
        if price_input_default is None:
            price_input_default = known[0]
        if price_output_default is None:
            price_output_default = known[1]
        console.print(
            f"[dim]Using Azure Foundry list prices for {state.llm_deployment}: "
            f"${known[0]} in / ${known[1]} out per 1M tokens. Override below if your "
            f"contract differs.[/dim]"
        )

    state.llm_price_input_per_1m = _ask_price(
        "Input price per 1M tokens (USD, blank to skip cost display)",
        current=price_input_default,
    )
    state.llm_price_output_per_1m = _ask_price(
        "Output price per 1M tokens (USD, blank to skip cost display)",
        current=price_output_default,
    )

    _step_llm_key(state)


def _step_llm_key(state: WizardState) -> None:
    """Sub-step of `_step_llm`: prompt for the API key + write to keyring."""
    ok, err = keyring_available()
    if not ok:
        console.print(
            f"[red]OS keyring is unavailable[/red]: {err or 'no backend detected'}.\n"
            "Install a keyring backend (`gnome-keyring` / `kwallet` on Linux, "
            "Keychain on macOS, Credential Manager on Windows) and re-run "
            "`docket setup --step=llm` to set the API key."
        )
        return

    existing = get_llm_api_key()
    if existing:
        existing_hint = make_hint(existing)
        preview = (
            f"{existing_hint.prefix}…{existing_hint.suffix}"
            if existing_hint.prefix
            else f"{existing_hint.length} chars"
        )
        console.print(f"[green]✓ existing API key in keyring[/green] [dim]({preview})[/dim]")
        if not Confirm.ask("Replace the stored API key?", default=False):
            state.llm_key_hint = existing_hint
            return

    raw = Prompt.ask("Azure OpenAI API key (input hidden)", password=True).strip()
    if not raw:
        console.print("[dim]Skipped — chat will 503 until a key is set.[/dim]")
        return
    try:
        hint = set_llm_api_key(raw)
    except Exception as e:  # pragma: no cover — defensive against locked keychain
        console.print(f"[red]Failed to write to keyring[/red]: {e}")
        return
    state.llm_key_hint = hint
    console.print("[green]✓ API key stored in OS keyring.[/green]")


def _ask_price(prompt: str, *, current: float | None) -> float | None:
    """Prompt for an optional float, prefilled from `current` (existing config).

    Returns None when the user clears the field (literal "none"/"" reply)."""
    default_str = f"{current}" if current is not None else ""
    while True:
        raw = Prompt.ask(prompt, default=default_str).strip().lower()
        if raw == "" or raw == "none":
            return None
        try:
            return float(raw)
        except ValueError:
            console.print("[red]Not a number — try again or leave blank.[/red]")


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
    """Layer the new provider entry onto whatever was loaded.

    Non-wizard fields (`ui`, `sync`, `stale`, `projects`, LLM advanced knobs)
    survive untouched so partial runs with `--step=<name>` don't clobber
    them. The actual layering is shared with HTTP `/setup/complete` via
    `compose_setup_config`."""
    providers = dict(state.existing.providers)
    providers[state.provider_key] = build_provider_entry(
        type_id=state.type_id,
        display_name=state.display_name,
        config=state.provider_config,
        scope=state.scope,
        existing=providers.get(state.provider_key),
    )
    active_provider = state.existing.active_provider
    if state.make_active or not active_provider:
        active_provider = state.provider_key
    composed = compose_setup_config(
        state.existing,
        providers=providers,
        active_provider=active_provider,
        telemetry_enabled=state.telemetry_enabled,
        telemetry_level=state.telemetry_level,
        http_enabled=state.http_enabled,
        http_bind=state.http_bind,
        http_port=state.http_port,
        http_token=state.http_token,
        llm_endpoint=state.llm_endpoint or None,
        llm_deployment=state.llm_deployment,
        price_input_per_1m=state.llm_price_input_per_1m,
        price_output_per_1m=state.llm_price_output_per_1m,
    )
    # Carry the hint forward only when the wizard actually touched the key
    # this run; otherwise preserve whatever was already in `state.existing`.
    if state.llm_key_hint is not None:
        composed = composed.model_copy(
            update={"llm": composed.llm.model_copy(update={"key_hint": state.llm_key_hint})}
        )
    return composed
