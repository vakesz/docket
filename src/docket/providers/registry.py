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
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

from pydantic import HttpUrl, ValidationError

from docket.core.model import ItemKind
from docket.providers.base import (
    ProviderFactory,
    ProviderSpec,
    ScopeAxis,
    SetupField,
    WorkItemProvider,
)
from docket.telemetry.logging import get_logger

_log = get_logger(__name__)

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


def normalize_config(type_id: str, config: dict[str, Any]) -> dict[str, Any]:
    """Apply the registered normalizer for `type_id`, returning a cleaned config.

    Providers opt in by setting `ProviderSpec.normalize_config`. For specs
    without a normalizer this is a no-op pass-through. `ValueError` from the
    normalizer surfaces to the caller — the setup and settings routes map it
    to HTTP 400 so the user sees what was wrong."""
    load_entry_points()
    spec_obj = _REGISTRY.get(type_id)
    if spec_obj is None:
        raise UnknownProviderError(
            f"unknown provider type '{type_id}' (known: {sorted(_REGISTRY)})"
        )
    if spec_obj.normalize_config is None:
        return config
    return spec_obj.normalize_config(config)


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
        except Exception as exc:
            # Don't brick the app on a broken third-party plugin; log loudly so
            # operators can still notice when a provider failed to register.
            _log.warning(
                "provider.plugin_load_failed",
                entry_point=ep.name,
                module=ep.value,
                error=repr(exc),
            )


def _register_builtins() -> None:
    """Wire the built-in provider specs and their wizard hooks. Called at
    module import so the registry is populated even without entry-point
    discovery."""
    from docket.providers.azure_devops.provider import AzureDevOpsProvider
    from docket.providers.azure_devops.scope import axis_matcher as azure_devops_axis_matcher
    from docket.providers.azure_devops.setup import register as register_ado_hooks
    from docket.providers.github.provider import GitHubProvider
    from docket.providers.github.setup import register as register_github_hooks
    from docket.providers.github_stub.provider import GitHubStubProvider
    from docket.providers.github_stub.setup import register as register_github_stub_hooks

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

    def _azure_devops_normalize(config: dict[str, Any]) -> dict[str, Any]:
        org = str(config.get("organization", "")).rstrip("/")
        try:
            config["organization"] = str(HttpUrl(org))
        except ValidationError as e:
            raise ValueError(f"organization must be a valid URL: {e}") from e
        project = str(config.get("project", "")).strip()
        if not project:
            raise ValueError("project is required")
        config["project"] = project
        return config

    def _azure_devops_label(config: Mapping[str, Any]) -> str:
        org_url = str(config.get("organization", ""))
        project = str(config.get("project", ""))
        org_slug = urlparse(org_url).path.strip("/") or urlparse(org_url).netloc
        if org_slug and project:
            return f"Azure DevOps · {org_slug}/{project}"
        if project:
            return f"Azure DevOps · {project}"
        return "Azure DevOps"

    def _github_label(config: Mapping[str, Any]) -> str:
        repo = str(config.get("default_repo", ""))
        base_url = str(config.get("base_url", ""))
        # api.github.com (the cloud default) collapses to the plain "GitHub"
        # prefix; any other base_url is a GHE host whose hostname doubles as
        # a useful disambiguator for users running multiple github entries.
        host = urlparse(base_url).netloc if base_url else ""
        prefix = host if host and host != "api.github.com" else "GitHub"
        return f"{prefix} · {repo}" if repo else prefix

    def _github_stub_label(config: Mapping[str, Any]) -> str:
        repo = str(config.get("default_repo", ""))
        return f"GitHub (stub) · {repo}" if repo else "GitHub (stub)"

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
            normalize_config=_azure_devops_normalize,
            label_template=_azure_devops_label,
            scope_axes=(
                ScopeAxis(key="team", label="Team", discovery_stage="teams"),
                ScopeAxis(key="area_path", label="Area path", discovery_stage="areas"),
                ScopeAxis(
                    key="iteration_path",
                    label="Iteration path",
                    discovery_stage="iterations",
                ),
            ),
            axis_matcher=azure_devops_axis_matcher,
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
            grouping="by_state_bucket",
            supported_kinds=(ItemKind.EPIC, ItemKind.STORY, ItemKind.TASK, ItemKind.BUG),
            label_template=_github_label,
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
            grouping="by_state_bucket",
            supported_kinds=(ItemKind.EPIC, ItemKind.STORY, ItemKind.TASK, ItemKind.BUG),
            label_template=_github_stub_label,
        )
    )

    register_ado_hooks()
    register_github_hooks()
    register_github_stub_hooks()


_register_builtins()


__all__ = [
    "ProviderFactory",
    "ProviderSpec",
    "SetupField",
    "UnknownProviderError",
    "build",
    "load_entry_points",
    "normalize_config",
    "register",
    "spec",
    "specs",
    "types",
]
