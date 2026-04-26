"""Shared primitives used by the setup wizard and `docket setup provider` CRUD.

The first-launch wizard (`setup_wizard.py`) and the incremental-edit surface
(`provider_crud.py`) share the same small toolkit: the Rich console, URL
validation, a numbered picker, and an assignee picker. This module is the
single home for those primitives so the dependency graph is `setup_wizard →
setup_utils` and `provider_crud → setup_utils` rather than `provider_crud →
setup_wizard` (which made the wizard's own split harder).

Provider-specific discovery pickers (e.g. GitHub host / repo) live in each
provider package's `setup.py` so this module stays free of concrete-provider
imports and any new provider type can be added without touching it.

No WizardState here — these helpers are stateless and return plain values
the caller folds back into whatever state container it uses."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final, Literal, overload
from urllib.parse import urlparse

from rich.prompt import Confirm, Prompt

from docket._console import console
from docket.providers.base import ProviderAuthError

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

    Shared by every provider's auth step in `setup_wizard` so the retry
    policy, messaging, and exit semantics stay in one place."""
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


def build_label_suggestion(*, type_id: str, config: dict[str, Any]) -> str:
    """Build a human-readable provider label from its config dict.

    Walks the provider registry and runs whichever spec's `label_template`
    matches the type — each provider plugin owns its own labeling so adding a
    new provider type doesn't require editing this module. Returns an empty
    string for unknown provider types or specs without a template; callers
    fall back to their own default (usually the provider key)."""
    from docket.providers import registry

    spec = registry.spec(type_id)
    if spec is None or spec.label_template is None:
        return ""
    return spec.label_template(config)


def next_sibling_key(type_id: str, taken: set[str]) -> str:
    """Return a free `<type_id>-<n>` key, given the set of already-taken ids.

    Promoted from `setup_wizard._next_sibling_key` so the HTTP wizard can
    suggest the same default when a re-run hits a configured instance.
    Returns the bare `type_id` when it isn't already taken."""
    if type_id not in taken:
        return type_id
    i = 2
    while f"{type_id}-{i}" in taken:
        i += 1
    return f"{type_id}-{i}"


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


__all__ = [
    "ANY_SENTINEL",
    "CUSTOM_SENTINEL",
    "build_label_suggestion",
    "console",
    "looks_like_http_url",
    "next_sibling_key",
    "pick",
    "pick_assignee",
    "step_auth_with_retry",
]
