from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field, HttpUrl

from docket.core.model import ScopeFilters


class TelemetryLevel(StrEnum):
    """Log levels surfaced in telemetry config + the setup wizard + settings UI.

    Same string values stdlib logging uses so `logging.getLevelName(level)`
    works unchanged — one source of truth instead of a regex pattern on the
    model, a `Literal` on the setup schema, and hand-written tuples in the
    wizard and Textual settings modal."""

    DEBUG = "DEBUG"
    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"
    CRITICAL = "CRITICAL"


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


def build_provider_entry(
    *,
    type_id: str,
    display_name: str,
    config: dict[str, Any],
    scope: ScopeFilter,
    existing: ProviderEntry | None = None,
) -> ProviderEntry:
    """Assemble a `ProviderEntry` with consistent scope-preservation policy.

    Why: every wizard / CLI / HTTP surface that edits providers had its own
    inlined construction, and at least one (`_build_config_from_state`)
    drifted — it read from `existing.active_scope` but wrote the user's edit
    into a hard-coded `"default"` slot, so reconfiguring a provider whose
    active scope was e.g. `"my-team"` silently lost the change.

    Policy:
      - No `existing`: fresh entry with `scopes={"default": scope}` and
        `active_scope="default"`.
      - With `existing`: keep every extra scope slot, replace only
        `existing.scopes[existing.active_scope]` with `scope`, and keep the
        active-scope name unchanged."""
    if existing is None:
        return ProviderEntry(
            type=type_id,
            display_name=display_name,
            config=dict(config),
            scopes={"default": scope},
            active_scope="default",
        )
    scopes = dict(existing.scopes)
    scopes[existing.active_scope] = scope
    return ProviderEntry(
        type=type_id,
        display_name=display_name,
        config=dict(config),
        scopes=scopes,
        active_scope=existing.active_scope,
    )


class LlmConfig(BaseModel):
    """LLM connection + runtime behavior. The concrete client today targets
    Azure OpenAI; `endpoint`/`deployment` identify that deployment."""

    endpoint: HttpUrl | None = None
    deployment: str = "gpt-5"
    compaction_threshold_tokens: int = 60000
    external_watch_interval_seconds: float = 60.0  # 0 disables the watcher
    # Per-million-token prices used to render the chat ledger ($X.XXXX) and
    # to accumulate `conversations.cost_cents`. Both unset = no cost shown.
    # Cached input bills off the input rate after subtracting cached_tokens_in.
    price_input_per_1m: float | None = None
    price_output_per_1m: float | None = None


class HttpConfig(BaseModel):
    enabled: bool = False
    bind: str = "127.0.0.1"
    port: int = 8765
    token: str = ""


class TelemetryConfig(BaseModel):
    """Local telemetry / logging settings.

    `enabled=True` (the default) routes every stdlib + structlog call through a
    rotating JSON file under `paths.log_dir`. `level` defaults to `DEBUG` so the
    on-disk log captures as much context as possible for the small group of
    operators reviewing it. Lower it to `INFO` if log volume becomes a problem."""

    enabled: bool = True
    level: TelemetryLevel = TelemetryLevel.DEBUG


class UiConfig(BaseModel):
    theme: str = "textual-dark"
    default_new_item_kind: str = Field(
        default="task",
        pattern="^(epic|feature|story|task|bug)$",
    )
    show_acceptance_criteria: bool = True
    # Whether to hide resolved/closed items from the backlog on startup.
    # The `c` key toggles it at runtime and writes back here so the choice
    # survives relaunches.
    hide_done: bool = True
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


class MCPServerEntry(BaseModel):
    """One MCP server, scoped to a project.

    Three transports are supported. `stdio` launches the server as a local
    subprocess (`command` + `args`, optional `env`). `http` (alias for the
    streamable-HTTP transport) and `sse` connect to a remote URL with optional
    `headers` (for `Authorization`, etc.). Discovered tools are auto-registered
    under `mcp__<server_name>__<tool>` regardless of transport.

    Set `enabled=False` to keep the entry in `config.toml` without spawning
    the server (useful for one-off debugging without losing the config)."""

    transport: str = "stdio"
    # stdio fields
    command: str = ""
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    # http/sse fields
    url: str = ""
    headers: dict[str, str] = Field(default_factory=dict)

    enabled: bool = True
    # How long to wait for the initial handshake / `tools/list` before giving
    # up and skipping the server. The agent build is best-effort: a slow
    # server should not block chat startup.
    startup_timeout_seconds: float = 10.0


class ProjectEntry(BaseModel):
    """User-facing project metadata persisted in `config.toml`.

    A project IS a provider — the dict key in `Config.projects` is the
    provider key, and all scopes on that provider share one project
    (one name, one description, one MCP fleet, one memory store). The
    SQLite `projects` table mirrors this for FK integrity (memory,
    sources, sub-agents) but `config.toml` is the source of truth for
    `name` and `description`. Renaming a project means editing this
    file."""

    provider_key: str
    name: str
    description: str = ""
    archived: bool = False
    # MCP servers exposed to this project's agent. Keyed by short name; the
    # name is what shows up in tool ids (`mcp__<name>__<tool>`), so keep it
    # short and stable — renaming invalidates the prompt prefix cache.
    mcp: dict[str, MCPServerEntry] = Field(default_factory=dict)


class Config(BaseModel):
    """Top-level `config.toml` schema. Every backend is a named entry under
    `providers`; `active_provider` picks which one the TUI opens by default."""

    providers: dict[str, ProviderEntry] = Field(default_factory=dict)
    active_provider: str = ""
    # Project metadata, keyed by provider key (one entry per provider). Scopes
    # are visual filters on the provider — they share the same project entry.
    projects: dict[str, ProjectEntry] = Field(default_factory=dict)
    llm: LlmConfig = Field(default_factory=LlmConfig)
    http: HttpConfig = Field(default_factory=HttpConfig)
    telemetry: TelemetryConfig = Field(default_factory=TelemetryConfig)
    ui: UiConfig = Field(default_factory=UiConfig)
    sync: SyncConfig = Field(default_factory=SyncConfig)
    stale: StaleConfig = Field(default_factory=StaleConfig)


def compose_setup_config(
    existing: Config | None,
    *,
    providers: dict[str, ProviderEntry],
    active_provider: str,
    telemetry_enabled: bool,
    telemetry_level: TelemetryLevel,
    http_enabled: bool,
    http_bind: str,
    http_port: int,
    http_token: str,
    llm_endpoint: str | None,
    llm_deployment: str,
    price_input_per_1m: float | None = None,
    price_output_per_1m: float | None = None,
) -> Config:
    """Merge wizard output onto an optional existing `Config`.

    Preserves `ui`, `sync`, `stale`, `projects`, and the LLM advanced knobs
    (`compaction_threshold_tokens`, `external_watch_interval_seconds`) when
    an existing config is handed in — otherwise falls back to pydantic
    defaults for the bootstrap case.

    Why this exists: the CLI wizard (`_build_config_from_state`) and the
    HTTP `/setup/complete` handler both reconstruct the top-level `Config`
    from wizard output, and they drifted — the HTTP path silently dropped
    `ui`, `sync`, `stale`, `projects` and the LLM advanced knobs by
    rebuilding a fresh `Config`. Routing both through this helper keeps
    them honest."""
    endpoint = HttpUrl(llm_endpoint) if llm_endpoint else None
    telemetry = TelemetryConfig(enabled=telemetry_enabled, level=telemetry_level)
    http = HttpConfig(
        enabled=http_enabled,
        bind=http_bind,
        port=http_port,
        token=http_token,
    )
    if existing is None:
        return Config(
            providers=providers,
            active_provider=active_provider,
            llm=LlmConfig(
                endpoint=endpoint,
                deployment=llm_deployment,
                price_input_per_1m=price_input_per_1m,
                price_output_per_1m=price_output_per_1m,
            ),
            http=http,
            telemetry=telemetry,
        )
    return existing.model_copy(
        update={
            "providers": providers,
            "active_provider": active_provider,
            "telemetry": telemetry,
            "http": http,
            "llm": existing.llm.model_copy(
                update={
                    "endpoint": endpoint,
                    "deployment": llm_deployment,
                    "price_input_per_1m": price_input_per_1m,
                    "price_output_per_1m": price_output_per_1m,
                }
            ),
        }
    )
