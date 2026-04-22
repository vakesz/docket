"""Provider registry — the single place that names map to ProviderSpecs.

Built-in providers register themselves at module import so `import
docket.providers` is enough to see them. Third-party providers opt in by
declaring a `docket.providers` entry point; `load_entry_points()` pulls them
in once at startup.

Each spec carries its factory plus the metadata the setup wizard needs
(display name, required CLIs, config fields). Onboarding surfaces iterate
specs so a new provider type shows up automatically without edits in
`api/routes/setup.py` or the CLI wizard."""

from __future__ import annotations

import importlib.metadata
from typing import Any

from docket.providers.base import ProviderFactory, ProviderSpec, SetupField, WorkItemProvider

_REGISTRY: dict[str, ProviderSpec] = {}
_ENTRY_POINTS_LOADED = False


class UnknownProviderError(KeyError):
    """Raised when `build()` sees a type id that was never registered."""


def register(spec: ProviderSpec) -> None:
    """Register a provider spec under its type id.

    Re-registering the same id replaces the previous spec — this lets a
    third-party package override a built-in if the user explicitly wires it.
    """
    _REGISTRY[spec.type_id] = spec


def build(type_id: str, config: dict[str, Any], *, display_name: str) -> WorkItemProvider:
    load_entry_points()
    spec = _REGISTRY.get(type_id)
    if spec is None:
        raise UnknownProviderError(
            f"unknown provider type '{type_id}' (known: {sorted(_REGISTRY)})"
        )
    return spec.factory(config, display_name)


def types() -> list[str]:
    """All currently-registered provider type ids, sorted."""
    load_entry_points()
    return sorted(_REGISTRY)


def specs() -> list[ProviderSpec]:
    """Every registered spec, sorted by type id."""
    load_entry_points()
    return [_REGISTRY[tid] for tid in sorted(_REGISTRY)]


def spec(type_id: str) -> ProviderSpec | None:
    load_entry_points()
    return _REGISTRY.get(type_id)


def load_entry_points() -> None:
    """Pull in `docket.providers` entry points exactly once per process.

    Each entry point resolves to a callable that takes no arguments and calls
    `register()` for whatever providers the package offers. Swallow per-entry
    errors so one broken plugin doesn't disable the TUI."""
    global _ENTRY_POINTS_LOADED
    if _ENTRY_POINTS_LOADED:
        return
    _ENTRY_POINTS_LOADED = True
    eps = importlib.metadata.entry_points(group="docket.providers")
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
    """Wire the built-in provider specs. Called at module import so the
    registry is populated even without entry-point discovery."""
    from docket.providers.azure_devops.provider import AzureDevOpsProvider
    from docket.providers.github.provider import GitHubProvider
    from docket.providers.github_stub.provider import GitHubStubProvider

    def _azure_devops_factory(config: dict[str, Any], display_name: str) -> WorkItemProvider:
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

    register(
        ProviderSpec(
            type_id="azure_devops",
            display_name="Azure DevOps",
            factory=_azure_devops_factory,
            requires_cli=("az",),
            setup_fields=(
                SetupField(
                    key="organization",
                    label="Organization URL",
                    kind="url",
                    required=True,
                    placeholder="https://dev.azure.com/your-org",
                    help="Full URL, e.g. https://dev.azure.com/contoso",
                ),
                SetupField(
                    key="project",
                    label="Project",
                    kind="string",
                    required=True,
                    placeholder="Docket",
                    help="Case-sensitive project name.",
                ),
            ),
        )
    )
    register(
        ProviderSpec(
            type_id="github",
            display_name="GitHub",
            factory=_github_factory,
            requires_cli=("gh",),
            setup_fields=(
                SetupField(
                    key="default_repo",
                    label="Default repository",
                    kind="string",
                    required=True,
                    placeholder="anthropics/claude-code",
                    help="owner/name pair.",
                ),
            ),
        )
    )
    register(
        ProviderSpec(
            type_id="github_stub",
            display_name="GitHub (in-memory)",
            factory=_github_stub_factory,
            setup_fields=(
                SetupField(
                    key="default_repo",
                    label="Default repository",
                    kind="string",
                    required=False,
                    placeholder="example/repo",
                ),
            ),
        )
    )


_register_builtins()


__all__ = [
    "ProviderFactory",
    "ProviderSpec",
    "SetupField",
    "UnknownProviderError",
    "build",
    "load_entry_points",
    "register",
    "spec",
    "specs",
    "types",
]
