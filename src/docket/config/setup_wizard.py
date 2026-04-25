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
from typing import Any

from pydantic import HttpUrl, ValidationError
from rich.panel import Panel
from rich.prompt import Confirm, Prompt

from docket.agent.prompt import scaffold as scaffold_prompts
from docket.config.loader import ConfigLoadPolicy, load_config, save_config
from docket.config.models import (
    Config,
    HttpConfig,
    ScopeFilter,
    TelemetryConfig,
    TelemetryLevel,
    build_provider_entry,
    compose_config,
)
from docket.config.paths import Paths, resolve_paths
from docket.config.setup_utils import (
    build_label_suggestion,
    console,
    looks_like_http_url,
    pick,
)
from docket.config.setup_wizard_azure_devops import (
    step_auth as _azure_devops_step_auth,
)
from docket.config.setup_wizard_azure_devops import (
    step_connection as _azure_devops_step_connection,
)
from docket.config.setup_wizard_azure_devops import (
    step_scope as _azure_devops_step_scope,
)
from docket.config.setup_wizard_github import (
    step_auth as _github_step_auth,
)
from docket.config.setup_wizard_github import (
    step_connection as _github_step_connection,
)
from docket.config.setup_wizard_github import (
    step_scope as _github_step_scope,
)
from docket.config.setup_wizard_github import (
    step_stub_connection as _github_stub_step_connection,
)
from docket.core.services import sync_service
from docket.providers import registry
from docket.storage import init_db

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
        cfg = load_config(paths, policy=ConfigLoadPolicy.OPTIONAL)
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


def _step_provider_auth(state: WizardState) -> None:
    match state.type_id:
        case "azure_devops":
            _azure_devops_step_auth(state)
        case "github":
            _github_step_auth(state)
        case "github_stub":
            console.print("[dim]No auth needed — github_stub runs entirely in-memory.[/dim]")
        case _:
            console.print(
                f"[dim]No built-in auth step for '{state.type_id}'. "
                "The provider factory will surface auth errors on first sync.[/dim]"
            )


# ---- step 3: connection (per-provider) --------------------------------------


def _step_provider_connection(state: WizardState) -> None:
    match state.type_id:
        case "azure_devops":
            _azure_devops_step_connection(state)
        case "github":
            _github_step_connection(state)
        case "github_stub":
            _github_stub_step_connection(state)
        case _:
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


def _step_provider_scope(state: WizardState) -> None:
    match state.type_id:
        case "azure_devops":
            _azure_devops_step_scope(state)
        case "github" | "github_stub":
            _github_step_scope(state)
        case _:
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
    """Layer the new provider entry onto whatever was loaded.

    Non-wizard fields (`ui`, `sync`, `stale`, `projects`, LLM advanced knobs)
    survive untouched so partial runs with `--step=<name>` don't clobber
    them. The actual layering is shared with HTTP `/setup/complete` via
    `compose_config`."""
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
    return compose_config(
        state.existing,
        providers=providers,
        active_provider=active_provider,
        telemetry=TelemetryConfig(
            enabled=state.telemetry_enabled,
            level=state.telemetry_level,
        ),
        http=HttpConfig(
            enabled=state.http_enabled,
            bind=state.http_bind,
            port=state.http_port,
            token=state.http_token,
        ),
        llm_endpoint=state.llm_endpoint or None,
        llm_deployment=state.llm_deployment,
    )
