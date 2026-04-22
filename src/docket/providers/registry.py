"""Provider registry — the single place that names map to factories.

Built-in providers register themselves at module import so `import
docket.providers` is enough to see them. Third-party providers opt in by
declaring a `docket.providers` entry point; `load_entry_points()` pulls them
in once at startup.

The factory signature is `(raw_config: dict, display_name: str) ->
WorkItemProvider`. The config is whatever the provider declared under its
`config.toml` entry — the registry does no validation, each factory owns
schema-checking its own section.
"""

from __future__ import annotations

import importlib.metadata
from collections.abc import Callable
from typing import Any

from docket.providers.base import WorkItemProvider

ProviderFactory = Callable[[dict[str, Any], str], WorkItemProvider]

_REGISTRY: dict[str, ProviderFactory] = {}
_ENTRY_POINTS_LOADED = False


class UnknownProviderError(KeyError):
    """Raised when `build()` sees a type id that was never registered."""


def register(type_id: str, factory: ProviderFactory) -> None:
    """Register a provider factory under a short type id (e.g. `"azure_devops"`).

    Re-registering the same id replaces the previous factory — this lets a
    third-party package override a built-in if the user explicitly wires it.
    """
    _REGISTRY[type_id] = factory


def build(type_id: str, config: dict[str, Any], *, display_name: str) -> WorkItemProvider:
    load_entry_points()
    factory = _REGISTRY.get(type_id)
    if factory is None:
        raise UnknownProviderError(
            f"unknown provider type '{type_id}' (known: {sorted(_REGISTRY)})"
        )
    return factory(config, display_name)


def types() -> list[str]:
    """All currently-registered provider type ids, sorted."""
    load_entry_points()
    return sorted(_REGISTRY)


def load_entry_points() -> None:
    """Pull in `docket.providers` entry points exactly once per process.

    Each entry point resolves to a callable that takes no arguments and calls
    `register()` for whatever providers the package offers. Swallow per-entry
    errors so one broken plugin doesn't disable the TUI."""
    global _ENTRY_POINTS_LOADED
    if _ENTRY_POINTS_LOADED:
        return
    _ENTRY_POINTS_LOADED = True
    try:
        eps = importlib.metadata.entry_points(group="docket.providers")
    except TypeError:
        # Python < 3.10 compat — not a supported runtime, but harmless fallback.
        eps = importlib.metadata.entry_points().get("docket.providers", [])  # type: ignore[attr-defined]
    for ep in eps:
        try:
            loader = ep.load()
            loader()
        except Exception:
            # Silent by design — a broken third-party plugin should not brick
            # the app. Users will notice when the provider doesn't appear in
            # the type list.
            continue


def _register_builtins() -> None:
    """Wire the built-in provider factories. Called at module import so the
    registry is populated even without entry-point discovery."""
    from docket.providers.azure_devops.provider import AzureDevOpsProvider
    from docket.providers.github.provider import GitHubProvider
    from docket.providers.github_stub.provider import GitHubStubProvider

    def _ado_factory(config: dict[str, Any], display_name: str) -> WorkItemProvider:
        organization = config.get("organization")
        project = config.get("project")
        if not organization or not project:
            raise ValueError("azure_devops provider requires 'organization' and 'project'")
        return AzureDevOpsProvider(
            organization_url=str(organization),
            project=str(project),
            display_name=display_name,
        )

    def _github_factory(config: dict[str, Any], display_name: str) -> WorkItemProvider:
        default_repo = config.get("default_repo")
        if not default_repo:
            raise ValueError("github provider requires 'default_repo' (owner/name)")
        return GitHubProvider(
            default_repo=str(default_repo),
            display_name=display_name,
            base_url=str(config.get("base_url", "https://api.github.com")),
        )

    def _github_stub_factory(config: dict[str, Any], display_name: str) -> WorkItemProvider:
        return GitHubStubProvider(
            default_repo=str(config.get("default_repo", "example/repo")),
            display_name=display_name,
        )

    register("azure_devops", _ado_factory)
    register("github", _github_factory)
    register("github_stub", _github_stub_factory)


_register_builtins()


__all__ = [
    "ProviderFactory",
    "UnknownProviderError",
    "build",
    "load_entry_points",
    "register",
    "types",
]
