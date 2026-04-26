"""Per-provider setup callbacks the wizard dispatches to.

The first-time setup wizard walks generic step names (`auth`, `connection`,
`scope`); each step asks the registered provider for the matching callable
and runs it. This module is the boundary that lets `config/setup_wizard.py`
stay free of concrete-provider imports — every provider package owns its
own `setup.py` that registers its hooks at import time.

Built-in providers register from `providers.registry._register_builtins`;
third-party providers register from their own setup module imported via the
`docket.providers` entry point.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


WizardStep = Callable[["WizardState"], None]
"""One wizard step. Reads/writes `state` in place; raises `SystemExit` to
abort the run when the user declines a hard prerequisite (e.g. auth retry
declined). Steps may be omitted from a `WizardHooks` — the wizard falls
through to a sensible default in that case."""


@dataclass(frozen=True)
class WizardHooks:
    """Per-provider onboarding callbacks.

    Any of `auth`, `connection`, `scope` may be `None`; the orchestrator
    falls through to a sensible default in that case (a short "no auth
    needed" message for `auth`, the spec-driven prompts for `connection`,
    and an empty scope for `scope`)."""

    auth: WizardStep | None = None
    connection: WizardStep | None = None
    scope: WizardStep | None = None


_HOOKS: dict[str, WizardHooks] = {}


def register(type_id: str, hooks: WizardHooks) -> None:
    """Register `hooks` under `type_id`. Re-registering replaces the previous entry."""
    _HOOKS[type_id] = hooks


def get(type_id: str) -> WizardHooks | None:
    """Return the registered hooks for `type_id`, or `None` if none registered."""
    return _HOOKS.get(type_id)


def registered_type_ids() -> list[str]:
    """Sorted list of every type id with registered hooks. Used by the test
    suite to assert no spec is missing a hook entry."""
    return sorted(_HOOKS)


__all__ = [
    "WizardHooks",
    "WizardStep",
    "get",
    "register",
    "registered_type_ids",
]
