"""First-time setup hooks for the in-memory `github_stub` provider.

The stub has no auth and a single config field (`default_repo`); this
module exists so the wizard's per-provider dispatch finds a hook for the
stub instead of falling through to the generic spec-driven path. Reuses
the github provider's assignee-only default-view step."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING

from rich.prompt import Prompt

from docket._console import console
from docket.config.setup_hooks import DiscoveryItem, WizardHooks
from docket.config.setup_hooks import register as register_hooks
from docket.providers.github.setup import step_view as github_step_view

if TYPE_CHECKING:
    from docket.config.setup_wizard import WizardState


def step_auth(state: WizardState) -> None:
    console.print("[dim]No auth needed — github_stub runs entirely in-memory.[/dim]")


def step_connection(state: WizardState) -> None:
    current = str(state.provider_config.get("default_repo", "example/repo"))
    repo = Prompt.ask("Default repo (owner/name)", default=current).strip() or current
    state.provider_config = {"default_repo": repo}


def discover_step(stage: str, payload: Mapping[str, str]) -> list[DiscoveryItem]:
    """No discovery — github_stub is in-memory and has nothing to scan.

    Returns an empty list for any stage so the SPA's wizard keeps the
    fallback "type a repo manually" UX instead of erroring out."""
    del payload
    if stage in ("hosts", "repos", "orgs", "org_repos"):
        return []
    raise ValueError(f"unknown stage: {stage!r}")


def register() -> None:
    register_hooks(
        "github_stub",
        WizardHooks(
            auth=step_auth,
            connection=step_connection,
            view=github_step_view,
            discover=discover_step,
        ),
    )


__all__ = ["discover_step", "register", "step_auth", "step_connection"]
