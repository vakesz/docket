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

from typing import TYPE_CHECKING
from urllib.parse import urlparse

from rich.console import Console
from rich.prompt import Prompt

if TYPE_CHECKING:
    from docket.providers.github.discover import HostRef

console = Console()

CUSTOM_SENTINEL = "__custom__"
"""Returned by `pick` when the user chose the 'custom…' option. Callers
compare via `is` so the literal never collides with a legitimate option."""

ANY_SENTINEL = "__any__"
"""Returned by `pick` with `allow_any=True` when the user chose 'any'.
Callers translate this to an empty-string scope filter."""


def looks_like_http_url(value: str) -> bool:
    """True when `value` parses as an `http://` or `https://` URL with a host.

    Used by the provider onboarding flows that accept an org/base URL.
    Keeps the check strict enough to reject bare hostnames (which Pydantic's
    `HttpUrl` would also reject later) without pulling in Pydantic here."""
    parsed = urlparse(value)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def pick(
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
    choice = pick("Assignee", options, allow_any=True, allow_custom=True)
    if choice is ANY_SENTINEL:
        return ""
    if choice is CUSTOM_SENTINEL:
        raw = Prompt.ask("Assignee (email or @me)", default=current_assignee or "@me").strip()
        return raw
    assert isinstance(choice, int)
    return options[choice]


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
    choice = pick("GitHub host", labels, allow_custom=True)
    if choice is CUSTOM_SENTINEL:
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
    choice = pick("GitHub repository", repos, allow_custom=True)
    if choice is CUSTOM_SENTINEL:
        return _prompt_github_repo_manual()
    assert isinstance(choice, int)
    return repos[choice]


def _prompt_github_repo_manual() -> str:
    while True:
        raw = Prompt.ask("Default repo (owner/name)", default="").strip()
        if "/" in raw and not raw.startswith("/") and not raw.endswith("/"):
            return raw
        console.print("[red]Please enter an owner/name pair, e.g. `anthropics/claude-code`.[/red]")


__all__ = [
    "ANY_SENTINEL",
    "CUSTOM_SENTINEL",
    "console",
    "looks_like_http_url",
    "pick",
    "pick_assignee",
    "pick_github_host",
    "pick_github_repo",
]
