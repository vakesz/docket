"""First-time setup hooks for the GitHub provider.

Owns the `gh auth` retry loop, the host + repo pickers (with manual
fallbacks), and the assignee-only scope step. Importing this module
registers the callbacks with `config.setup_hooks`."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

from rich.prompt import Prompt

from docket._console import console
from docket.config.setup_hooks import DiscoveryItem, WizardHooks
from docket.config.setup_hooks import register as register_hooks
from docket.config.setup_utils import pick, pick_assignee, step_auth_with_retry
from docket.providers.github import discover
from docket.providers.github.auth import ensure_logged_in, signed_in_email
from docket.providers.github.discover import HostRef

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


def step_auth(state: WizardState) -> None:
    step_auth_with_retry(ensure_logged_in, service_label="GitHub CLI")
    state.signed_in_email = signed_in_email()


def step_connection(state: WizardState) -> None:
    host = pick_github_host()
    repo = pick_github_repo(host=host.hostname if host else None)
    config: dict[str, Any] = {"default_repo": repo}
    if host and host.api_base_url != "https://api.github.com":
        config["base_url"] = host.api_base_url
    state.provider_config = config


def step_scope(state: WizardState) -> None:
    """GitHub scope is just the assignee — team/area/iteration don't apply."""
    from docket.config.models import ScopeFilter

    console.print(
        "Scope filters limit which issues/PRs get cached locally. "
        "Only 'assignee' is meaningful for GitHub."
    )
    assignee = pick_assignee(
        signed_in_email=state.signed_in_email,
        current_assignee=state.scope.assignee,
    )
    state.scope = ScopeFilter(assignee=assignee)


def pick_github_host() -> HostRef | None:
    """Offer every authenticated gh host, plus a custom-URL escape hatch.

    Returns `None` only when the user has a single github.com host and we
    don't need to disambiguate — callers treat that as "use the default
    `api.github.com` base URL and the default `gh` host."""
    hosts = discover.list_hosts()
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
    match pick("GitHub host", labels, allow_custom=True):
        case "__custom__":
            return _prompt_github_host_manual()
        case int(idx):
            return hosts[idx]


def _prompt_github_host_manual() -> HostRef:
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


def pick_github_repo(*, host: str | None = None) -> str:
    """Offer discovered repos for the active `gh` session, or fall back to typing.

    Composition:
      1. The authenticated user's own repos (`/user/repos`).
      2. Every org the user is a member of — via `/orgs/{org}/repos` so
         private repos they have access to show up too (not just the
         public ones `/users/{login}/repos` would return).

    We merge into a single de-duplicated picker ordered by discovery so
    "my repos first, then each org in turn" reads naturally. The custom
    option lets the user type any repo they can read — including
    open-source repos they don't own (e.g. `anthropics/claude-code`). Any
    discovery failure falls through to the remaining sources, and if
    nothing comes back we drop to the manual prompt so a user without
    `gh` (or in zero orgs and zero repos) can still finish."""
    seen: set[str] = set()
    repos: list[str] = []

    def _add(refs: list[discover.RepoRef]) -> None:
        for ref in refs:
            if ref.full_name not in seen:
                seen.add(ref.full_name)
                repos.append(ref.full_name)

    login = discover.signed_in_login(host=host)
    host_label = host or "github.com"
    if login:
        console.print(
            f"[dim]Scanning repos on [cyan]{host_label}[/cyan] for [cyan]{login}[/cyan]...[/dim]"
        )
    else:
        console.print(f"[dim]Scanning repos on [cyan]{host_label}[/cyan]...[/dim]")

    discovery_errors: list[str] = []

    # Section 1: the user's own repos.
    try:
        _add(discover.list_repos(host=host))
    except discover.DiscoveryError as e:
        discovery_errors.append(f"personal repos: {e}")

    # Section 2: repos in every org the user belongs to. `gh` silently
    # returns an empty list when the user is in no orgs, so this is free.
    try:
        orgs = discover.list_orgs(host=host)
    except discover.DiscoveryError as e:
        discovery_errors.append(f"orgs: {e}")
        orgs = []
    for org in orgs:
        before = len(repos)
        try:
            _add(discover.list_org_repos(org.login, host=host))
        except discover.DiscoveryError as e:
            console.print(f"[yellow]Skipping org [cyan]{org.login}[/cyan]:[/yellow] {e}")
            continue
        added = len(repos) - before
        console.print(f"[dim]  · [cyan]{org.login}[/cyan]: {added} repo(s)[/dim]")

    if discovery_errors:
        # Make failures loud, not dim — if we end up at the manual prompt
        # below, the user needs to know why discovery returned nothing.
        for detail in discovery_errors:
            console.print(
                f"[yellow]GitHub discovery issue on [cyan]{host_label}[/cyan] ({detail})[/yellow]"
            )

    if not repos:
        console.print("[yellow]No repositories discovered.[/yellow]")
        console.print()
        console.print(
            "You can still type any repo you have read access to below "
            "(including public repos you don't own, e.g. "
            "[cyan]anthropics/claude-code[/cyan])."
        )
        return _prompt_github_repo_manual()

    console.print(
        "[dim]Don't see the repo you want? Choose [cyan]custom…[/cyan] to type "
        "any repo you can read (e.g. [cyan]anthropics/claude-code[/cyan]).[/dim]"
    )
    match pick("GitHub repository", repos, allow_custom=True):
        case "__custom__":
            return _prompt_github_repo_manual()
        case int(idx):
            return repos[idx]


def _prompt_github_repo_manual() -> str:
    while True:
        raw = Prompt.ask("Default repo (owner/name)", default="").strip()
        if "/" in raw and not raw.startswith("/") and not raw.endswith("/"):
            return raw
        console.print("[red]Please enter an owner/name pair, e.g. `anthropics/claude-code`.[/red]")


def discover_step(stage: str, payload: Mapping[str, str]) -> list[DiscoveryItem]:
    """Stage-driven discovery for the SPA wizard's pickers.

    Stage map (1:1 with `providers.github.discover`):
      - `hosts`     → no payload → `[{value=hostname, label=hostname,
                       extras.api_base_url=...}]`
      - `repos`     → `{host?}` → `[{value=full_name, label=full_name}]`
      - `orgs`      → `{host?}` → `[{value=login, label=login}]`
      - `org_repos` → `{org, host?}` → `[{value=full_name, label=full_name}]`

    `DiscoveryError` from the underlying helper bubbles up. Unknown
    stages raise `ValueError`. The host argument defaults to the gh
    CLI's active host when omitted, mirroring the CLI wizard."""
    host = payload.get("host", "").strip() or None
    if stage == "hosts":
        return [
            DiscoveryItem(
                value=h.hostname,
                label=h.hostname,
                extras={"api_base_url": h.api_base_url},
            )
            for h in discover.list_hosts()
        ]
    if stage == "repos":
        return [
            DiscoveryItem(value=r.full_name, label=r.full_name)
            for r in discover.list_repos(host=host)
        ]
    if stage == "orgs":
        return [DiscoveryItem(value=o.login, label=o.login) for o in discover.list_orgs(host=host)]
    if stage == "org_repos":
        org = payload.get("org", "").strip()
        if not org:
            raise ValueError("payload.org is required for stage 'org_repos'")
        return [
            DiscoveryItem(value=r.full_name, label=r.full_name)
            for r in discover.list_org_repos(org, host=host)
        ]
    raise ValueError(f"unknown stage: {stage!r}")


def register() -> None:
    register_hooks(
        "github",
        WizardHooks(
            auth=step_auth,
            connection=step_connection,
            scope=step_scope,
            discover=discover_step,
        ),
    )


__all__ = [
    "discover_step",
    "pick_github_host",
    "pick_github_repo",
    "register",
    "step_auth",
    "step_connection",
    "step_scope",
]
