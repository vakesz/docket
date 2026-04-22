from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, HttpUrl


class ScopeFilter(BaseModel):
    """A named scope filter for work-item sync."""

    team: str = ""
    area_path: str = ""
    iteration_path: str = ""
    assignee: str = "@me"


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


class Config(BaseModel):
    """Top-level `config.toml` schema. Every backend is a named entry under
    `providers`; `active_provider` picks which one the TUI opens by default."""

    providers: dict[str, ProviderEntry] = Field(default_factory=dict)
    active_provider: str = ""
    llm: LlmConfig = Field(default_factory=LlmConfig)
    http: HttpConfig = Field(default_factory=HttpConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    ui: UiConfig = Field(default_factory=UiConfig)
    sync: SyncConfig = Field(default_factory=SyncConfig)
    stale: StaleConfig = Field(default_factory=StaleConfig)
