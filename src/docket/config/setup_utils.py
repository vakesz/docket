"""Shared primitives used by the setup wizard and `docket setup provider` CRUD.

The first-launch wizard (`setup_wizard.py`) and the incremental-edit surface
(`provider_crud.py`) share the same small toolkit: the Rich console, URL
validation, a numbered picker, and GitHub host/repo discovery pickers. This
module is the single home for those primitives so the dependency graph is
`setup_wizard → setup_utils` and `provider_crud → setup_utils` rather than
`provider_crud → setup_wizard` (which made the wizard's own split harder).

No WizardState here — these helpers are stateless and return plain values
the caller folds back into whatever state container it uses."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Final, Literal, overload
from urllib.parse import urlparse

from rich.console import Console
from rich.prompt import Confirm, Prompt

from docket.providers.base import ProviderAuthError

if TYPE_CHECKING:
    from docket.providers.github.discover import HostRef

console = Console()

CUSTOM_SENTINEL: Final[Literal["__custom__"]] = "__custom__"
"""Returned by `pick` when the user chose the 'custom…' option. Callers
match on the literal so it never collides with a legitimate option."""

ANY_SENTINEL: Final[Literal["__any__"]] = "__any__"
"""Returned by `pick` with `allow_any=True` when the user chose 'any'.
Callers translate this to an empty-string scope filter."""

PickChoice = int | Literal["__any__", "__custom__"]
"""Result of `pick`: either a 0-based option index, or a sentinel for the
'any' / 'custom…' escape hatches. The Literal types let `match`/`is`
branches narrow away the sentinels without an explicit `isinstance` check."""


def step_auth_with_retry(
    ensure_logged_in: Callable[[], str],
    *,
    service_label: str,
) -> str:
    """Run `ensure_logged_in` with user-driven retry on auth failure.

    Prints a "Checking ... session..." header, loops until the provider's
    auth helper returns an identity string, and returns it. A declined retry
    raises `SystemExit(1)` — the wizard cannot meaningfully continue without
    an authenticated session.

    Shared by `setup_wizard_github` and `setup_wizard_azure_devops` so the
    retry policy, messaging, and exit semantics stay in one place."""
    console.print(f"Checking {service_label} session...")
    while True:
        try:
            identity = ensure_logged_in()
        except ProviderAuthError as e:
            console.print(f"[yellow]{e}[/yellow]")
            if not Confirm.ask("Retry now?", default=True):
                raise SystemExit(1) from e
            continue
        console.print(f"[green]✓ signed in as[/green] {identity}")
        return identity


def build_label_suggestion(
    *,
    type_id: str,
    config: dict[str, Any],
    github_host_hint: str = "",
) -> str:
    """Build a human-readable provider label from its config dict.

    Used as the default for the display-name prompt in both the first-run
    wizard (`setup_wizard._suggest_display_name`) and incremental
    `docket setup provider add` (`provider_crud`). Returns an empty string
    only for unknown provider types where no useful label can be inferred —
    callers fall back to their own default (usually the provider key).

    `github_host_hint` is the signed-in GH hostname captured during the
    connection step; when it's a GHE host (not `github.com`) it replaces
    the "GitHub" prefix so labels distinguish cloud from enterprise."""
    if type_id == "azure_devops":
        org_url = str(config.get("organization", ""))
        project = str(config.get("project", ""))
        org_slug = urlparse(org_url).path.strip("/") or urlparse(org_url).netloc
        if org_slug and project:
            return f"Azure DevOps · {org_slug}/{project}"
        if project:
            return f"Azure DevOps · {project}"
        return "Azure DevOps"
    if type_id == "github":
        repo = str(config.get("default_repo", ""))
        prefix = (
            github_host_hint if github_host_hint and github_host_hint != "github.com" else "GitHub"
        )
        return f"{prefix} · {repo}" if repo else prefix
    if type_id == "github_stub":
        repo = str(config.get("default_repo", ""))
        return f"GitHub (stub) · {repo}" if repo else "GitHub (stub)"
    return ""


def looks_like_http_url(value: str) -> bool:
    """True when `value` parses as an `http://` or `https://` URL with a host.

    Used by the provider onboarding flows that accept an org/base URL.
    Keeps the check strict enough to reject bare hostnames (which Pydantic's
    `HttpUrl` would also reject later) without pulling in Pydantic here."""
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


@overload
def pick(label: str, options: list[str]) -> int: ...
@overload
def pick(
    label: str,
    options: list[str],
    *,
    allow_any: Literal[True],
    allow_custom: Literal[True],
) -> int | Literal["__any__", "__custom__"]: ...
@overload
def pick(
    label: str,
    options: list[str],
    *,
    allow_any: Literal[True],
    allow_custom: Literal[False] = False,
) -> int | Literal["__any__"]: ...
@overload
def pick(
    label: str,
    options: list[str],
    *,
    allow_any: Literal[False] = False,
    allow_custom: Literal[True],
) -> int | Literal["__custom__"]: ...
def pick(
    label: str,
    options: list[str],
    *,
    allow_any: bool = False,
    allow_custom: bool = False,
) -> PickChoice:
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
        return ANY_SENTINEL
    if custom_key is not None and raw == custom_key:
        return CUSTOM_SENTINEL
    return int(raw) - 1 - offset


def pick_assignee(*, signed_in_email: str | None, current_assignee: str) -> str:
    """Offer any, @me, the detected email, and custom. Returns '' for 'any'.

    'any' is the default — defaulting to @me silently filters to the user's
    assigned items, which looks like a broken sync on third-party repos where
    they aren't a maintainer."""
    options: list[str] = ["@me"]
    if signed_in_email and signed_in_email not in options:
        options.append(signed_in_email)
    match pick("Assignee", options, allow_any=True, allow_custom=True):
        case "__any__":
            return ""
        case "__custom__":
            return Prompt.ask("Assignee (email or @me)", default=current_assignee or "@me").strip()
        case int(idx):
            return options[idx]


def pick_github_host() -> HostRef | None:
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
    match pick("GitHub host", labels, allow_custom=True):
        case "__custom__":
            return _prompt_github_host_manual()
        case int(idx):
            return hosts[idx]


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
    else:
        console.print(f"[dim]Scanning repos on [cyan]{host_label}[/cyan]...[/dim]")

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


__all__ = [
    "ANY_SENTINEL",
    "CUSTOM_SENTINEL",
    "build_label_suggestion",
    "console",
    "looks_like_http_url",
    "pick",
    "pick_assignee",
    "pick_github_host",
    "pick_github_repo",
    "step_auth_with_retry",
]
