from __future__ import annotations

from pydantic import BaseModel, Field, HttpUrl


class ScopeFilter(BaseModel):
    """A named scope filter for work-item sync."""

    team: str = ""
    area_path: str = ""
    iteration_path: str = ""
    assignee: str = "@me"


class AdoConfig(BaseModel):
    organization: HttpUrl
    project: str
    description_format: str = Field(default="markdown", pattern="^(markdown|html_fallback)$")


class FoundryConfig(BaseModel):
    endpoint: HttpUrl | None = None
    deployment: str = "gpt-5"


class HttpConfig(BaseModel):
    enabled: bool = False
    bind: str = "127.0.0.1"
    port: int = 8765
    token: str = ""


class TelemetryConfig(BaseModel):
    enabled: bool = True


class LlmConfig(BaseModel):
    compaction_threshold_tokens: int = 60000
    external_watch_interval_seconds: float = 60.0  # 0 disables the watcher


class UiConfig(BaseModel):
    theme: str = "textual-dark"


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
    """Top-level config.toml schema."""

    ado: AdoConfig
    scopes: dict[str, ScopeFilter] = Field(default_factory=lambda: {"default": ScopeFilter()})
    active_scope: str = "default"
    foundry: FoundryConfig = Field(default_factory=FoundryConfig)
    http: HttpConfig = Field(default_factory=HttpConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    llm: LlmConfig = Field(default_factory=LlmConfig)
    ui: UiConfig = Field(default_factory=UiConfig)
    sync: SyncConfig = Field(default_factory=SyncConfig)
    stale: StaleConfig = Field(default_factory=StaleConfig)
