from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, HttpUrl

from docket.core.model import ScopeFilters


class ScopeFilter(BaseModel):
    """A named scope filter for work-item sync."""

    team: str = ""
    area_path: str = ""
    iteration_path: str = ""
    assignee: str = "@me"

    def to_core(self) -> ScopeFilters:
        """Convert to the core-layer filter (same shape, different layer).

        Providers and services accept `core.model.ScopeFilters`; `ScopeFilter`
        is the pydantic config model. Keep the two separate so core has no
        pydantic dependency, but offer the obvious conversion here."""
        return ScopeFilters(
            team=self.team,
            area_path=self.area_path,
            iteration_path=self.iteration_path,
            assignee=self.assignee,
        )


class ProviderEntry(BaseModel):
    """One configured backend. `type` maps to a registry id (`"azure_devops"`,
    `"github_stub"`, or anything registered via entry point). `config` is
    free-form and validated by the factory — the registry itself does not
    peek inside.

    Each provider owns its own scopes + active_scope: when you switch
    providers in the TUI, both the work-item pane and the view filter reset
    to that provider's default."""

    type: str
    display_name: str
    config: dict[str, Any] = Field(default_factory=dict)
    scopes: dict[str, ScopeFilter] = Field(default_factory=lambda: {"default": ScopeFilter()})
    active_scope: str = "default"


class LlmConfig(BaseModel):
    """LLM connection + runtime behavior. The concrete client today targets
    Azure OpenAI; `endpoint`/`deployment` identify that deployment."""

    endpoint: HttpUrl | None = None
    deployment: str = "gpt-5"
    compaction_threshold_tokens: int = 60000
    external_watch_interval_seconds: float = 60.0  # 0 disables the watcher


class HttpConfig(BaseModel):
    enabled: bool = False
    bind: str = "127.0.0.1"
    port: int = 8765
    token: str = ""


class TelemetryConfig(BaseModel):
    enabled: bool = True


class UiConfig(BaseModel):
    theme: str = "textual-dark"
    default_new_item_kind: str = Field(
        default="task",
        pattern="^(epic|feature|story|task|bug)$",
    )
    show_acceptance_criteria: bool = True
    # Web UI only: number of tag-filter chips to show before the "+N more"
    # toggle. 0 disables collapsing (show every tag).
    tag_filter_collapse_limit: int = Field(default=4, ge=0, le=100)


class SyncConfig(BaseModel):
    """Background sync knobs. Off by default — the TUI still has a manual
    `Sync now` action via the command palette / keybind. Per-provider floors
    protect against rate limits when the user sets a short global interval."""

    background_interval_seconds: float = 0.0
    min_interval_seconds_by_provider: dict[str, float] = Field(default_factory=dict)


class StaleConfig(BaseModel):
    """`STALE - Xd` marker thresholds. Per-provider overrides win over the
    global default; missing entries fall back to `threshold_days`."""

    threshold_days: int = 7
    threshold_days_by_provider: dict[str, int] = Field(default_factory=dict)


class ProjectEntry(BaseModel):
    """User-facing project metadata persisted in `config.toml`.

    A project is identified by `(provider_key, scope_key)` — those two fields
    plus the dict key in `Config.projects` form the composite identity. The
    SQLite `projects` table mirrors this for FK integrity (memory, sources,
    sub-agents) but `config.toml` is the source of truth for `name` and
    `description`. Renaming a project means editing this file."""

    provider_key: str
    scope_key: str
    name: str
    description: str = ""
    archived: bool = False


class Config(BaseModel):
    """Top-level `config.toml` schema. Every backend is a named entry under
    `providers`; `active_provider` picks which one the TUI opens by default."""

    providers: dict[str, ProviderEntry] = Field(default_factory=dict)
    active_provider: str = ""
    # Project metadata, keyed by the composite id `f"{provider_key}::{scope_key}"`.
    # The active project is derived from `(active_provider, providers[active_provider].active_scope)`.
    projects: dict[str, ProjectEntry] = Field(default_factory=dict)
    llm: LlmConfig = Field(default_factory=LlmConfig)
    http: HttpConfig = Field(default_factory=HttpConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    ui: UiConfig = Field(default_factory=UiConfig)
    sync: SyncConfig = Field(default_factory=SyncConfig)
    stale: StaleConfig = Field(default_factory=StaleConfig)
