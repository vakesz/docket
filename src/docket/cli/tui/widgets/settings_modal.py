from __future__ import annotations

from collections.abc import Callable
from typing import Any, ClassVar, Literal, overload

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Checkbox, Input, Select, Static

from docket.config.loader import save_config
from docket.config.models import Config, ProviderEntry, ScopeFilter, TelemetryLevel
from docket.config.paths import Paths
from docket.providers import registry

_NEW_SCOPE = "__new__"


def _parse_scalar[T: (int, float)](
    raw: str, converter: Callable[[str], T], *, field_name: str
) -> T:
    try:
        return converter(raw.strip())
    except ValueError as exc:
        noun = "an integer" if converter is int else "a number"
        raise ValueError(f"{field_name} must be {noun}.") from exc


@overload
def _parse_map(raw: str, *, value_type: Literal["float"]) -> dict[str, float]: ...
@overload
def _parse_map(raw: str, *, value_type: Literal["int"]) -> dict[str, int]: ...
def _parse_map(
    raw: str, *, value_type: Literal["float", "int"]
) -> dict[str, float] | dict[str, int]:
    text = raw.strip()
    if not text:
        return {}
    entries: list[tuple[str, str]] = []
    for chunk in text.split(","):
        entry = chunk.strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ValueError(
                "Override mappings must look like `Provider=123`, separated by commas."
            )
        key, value = entry.split("=", 1)
        provider = key.strip()
        if not provider:
            raise ValueError("Override mappings need a provider name before `=`.")
        entries.append((provider, value))
    if value_type == "float":
        return {p: _parse_scalar(v, float, field_name=f"{p} override") for p, v in entries}
    return {p: _parse_scalar(v, int, field_name=f"{p} override") for p, v in entries}


def _format_map(raw: dict[str, float] | dict[str, int]) -> str:
    return ", ".join(f"{key}={value}" for key, value in raw.items())


def _format_optional_float(value: float | None) -> str:
    return "" if value is None else f"{value}"


def _parse_optional_float(raw: str, *, field_name: str) -> float | None:
    text = raw.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a number or blank.") from exc


class SettingsModal(ModalScreen[Config | None]):
    DEFAULT_CSS = """
    SettingsModal { align: center middle; }
    SettingsModal > Vertical {
        width: 98;
        max-width: 120;
        height: 88%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    SettingsModal #title {
        height: auto;
        color: $accent;
        text-style: bold;
    }
    SettingsModal #subtitle {
        height: auto;
        color: $text-muted;
        padding-bottom: 1;
    }
    SettingsModal VerticalScroll {
        height: 1fr;
        border: round $panel-lighten-1;
        background: $panel;
        padding: 0 1 1 1;
    }
    SettingsModal .section {
        height: auto;
        color: $accent;
        text-style: bold;
        padding-top: 1;
    }
    SettingsModal .field-label {
        height: auto;
        color: $text-muted;
        padding-top: 1;
    }
    SettingsModal .checkbox {
        padding-top: 1;
    }
    SettingsModal #hint {
        height: auto;
        color: $text-muted;
        padding-top: 1;
    }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("escape", "cancel", "Cancel", priority=True),
    ]

    def __init__(self, paths: Paths, config: Config) -> None:
        super().__init__()
        self._paths = paths
        self._config = config
        # Edits are scoped to whichever provider is active when the modal
        # opens — the user can switch providers from the palette first if
        # they want to edit a different one.
        self._active_provider_key = (
            config.active_provider
            if config.active_provider in config.providers
            else next(iter(config.providers), "")
        )

    @property
    def _active_entry(self) -> ProviderEntry | None:
        if not self._active_provider_key:
            return None
        return self._config.providers.get(self._active_provider_key)

    def compose(self) -> ComposeResult:
        entry = self._active_entry
        scopes = entry.scopes if entry is not None else {}
        active_scope_name = entry.active_scope if entry is not None else "default"
        scope_options = [("Create new view…", _NEW_SCOPE)]
        scope_options.extend((name, name) for name in sorted(scopes))
        active_scope_value = active_scope_name if active_scope_name in scopes else _NEW_SCOPE
        current_scope = scopes.get(active_scope_name, ScopeFilter())

        provider_type = entry.type if entry is not None else "github"
        provider_spec = registry.spec(provider_type)
        with Vertical():
            yield Static("Settings", id="title")
            yield Static(
                "Saved to config.toml. Visual behavior updates in this session; "
                "provider connection changes apply on the next launch.",
                id="subtitle",
            )
            with VerticalScroll():
                yield Static("Views & scope", classes="section")
                yield Static(
                    f"editing saved views for [cyan]{self._active_provider_key or '—'}[/cyan]",
                    classes="field-label",
                )
                yield Static("saved view", classes="field-label")
                scope_picker = Select(
                    options=scope_options,
                    value=active_scope_value,
                    prompt="pick a saved view",
                    id="scope-select",
                )
                scope_picker.tooltip = "Choose a saved view to edit, or create a new one."
                yield scope_picker
                yield Static("view name", classes="field-label")
                yield Input(value=active_scope_name, placeholder="view name", id="scope-name")
                default_checkbox = Checkbox(
                    "Make this the default view",
                    value=True,
                    id="scope-default",
                    classes="checkbox",
                )
                default_checkbox.tooltip = "When enabled, Docket opens this view by default."
                yield default_checkbox
                yield Static("team", classes="field-label")
                yield Input(
                    value=current_scope.team, placeholder="team (optional)", id="scope-team"
                )
                yield Static("area path", classes="field-label")
                yield Input(
                    value=current_scope.area_path,
                    placeholder="Project\\Area (optional)",
                    id="scope-area",
                )
                yield Static("iteration path", classes="field-label")
                yield Input(
                    value=current_scope.iteration_path,
                    placeholder="Project\\Iteration (optional)",
                    id="scope-iteration",
                )
                yield Static("assignee", classes="field-label")
                yield Input(
                    value=current_scope.assignee,
                    placeholder="@me, email, or blank for any",
                    id="scope-assignee",
                )

                yield Static("Active provider", classes="section")
                yield Static("provider type", classes="field-label")
                yield Static(
                    f"[cyan]{provider_type}[/cyan] — edit other provider types "
                    "via `docket setup provider ...`.",
                    id="provider-type-note",
                )
                yield Static("display name", classes="field-label")
                yield Input(
                    value=entry.display_name if entry is not None else "",
                    placeholder=provider_spec.display_name if provider_spec else "",
                    id="provider-display",
                )
                if provider_spec is not None:
                    for setup_field in provider_spec.setup_fields:
                        yield Static(setup_field.label, classes="field-label")
                        current = (
                            str(entry.config.get(setup_field.key, "")) if entry is not None else ""
                        )
                        yield Input(
                            value=current,
                            placeholder=setup_field.placeholder,
                            id=f"provider-cfg-{setup_field.key}",
                            password=setup_field.kind == "secret",
                        )

                yield Static("LLM endpoint", classes="field-label")
                yield Input(
                    value=str(self._config.llm.endpoint or ""),
                    placeholder="https://your-resource.openai.azure.com/",
                    id="llm-endpoint",
                )
                yield Static("LLM deployment", classes="field-label")
                yield Input(
                    value=self._config.llm.deployment,
                    placeholder="gpt-5",
                    id="llm-deployment",
                )
                yield Static("Input price per 1M tokens (USD)", classes="field-label")
                yield Input(
                    value=_format_optional_float(self._config.llm.price_input_per_1m),
                    placeholder="blank to hide cost",
                    id="llm-price-input",
                )
                yield Static("Output price per 1M tokens (USD)", classes="field-label")
                yield Input(
                    value=_format_optional_float(self._config.llm.price_output_per_1m),
                    placeholder="blank to hide cost",
                    id="llm-price-output",
                )

                yield Static("Behavior", classes="section")
                yield Static("theme", classes="field-label")
                yield Static(
                    f"{self._config.ui.theme}  ·  change it from the theme picker (`Ctrl+T`)",
                    id="theme-note",
                )
                yield Static("default new item kind", classes="field-label")
                yield Select(
                    options=[
                        ("Epic", "epic"),
                        ("Feature", "feature"),
                        ("Story", "story"),
                        ("Task", "task"),
                        ("Bug", "bug"),
                    ],
                    value=self._config.ui.default_new_item_kind,
                    prompt="default kind",
                    id="ui-default-kind",
                )
                criteria_checkbox = Checkbox(
                    "Show acceptance criteria in the chat pane",
                    value=self._config.ui.show_acceptance_criteria,
                    id="ui-show-criteria",
                    classes="checkbox",
                )
                criteria_checkbox.tooltip = "Hide this if you prefer a cleaner chat pane."
                yield criteria_checkbox
                yield Static("compaction threshold tokens", classes="field-label")
                yield Input(
                    value=str(self._config.llm.compaction_threshold_tokens),
                    placeholder="60000",
                    id="llm-compaction",
                )
                yield Static("external watch interval seconds", classes="field-label")
                yield Input(
                    value=str(self._config.llm.external_watch_interval_seconds),
                    placeholder="60",
                    id="llm-watch",
                )
                yield Static("background sync interval seconds", classes="field-label")
                yield Input(
                    value=str(self._config.sync.background_interval_seconds),
                    placeholder="0 disables",
                    id="sync-background",
                )
                yield Static("per-provider minimum sync overrides", classes="field-label")
                sync_override = Input(
                    value=_format_map(self._config.sync.min_interval_seconds_by_provider),
                    placeholder="Azure DevOps=300, GitHub=600",
                    id="sync-min-overrides",
                )
                sync_override.tooltip = "Optional per-provider minimums in seconds."
                yield sync_override
                yield Static("stale threshold days", classes="field-label")
                yield Input(
                    value=str(self._config.stale.threshold_days),
                    placeholder="7",
                    id="stale-threshold",
                )
                yield Static("per-provider stale overrides", classes="field-label")
                stale_override = Input(
                    value=_format_map(self._config.stale.threshold_days_by_provider),
                    placeholder="Azure DevOps=7, GitHub=5",
                    id="stale-overrides",
                )
                stale_override.tooltip = "Optional per-provider stale thresholds in days."
                yield stale_override

                yield Static("HTTP & telemetry", classes="section")
                http_checkbox = Checkbox(
                    "Enable the HTTP API",
                    value=self._config.http.enabled,
                    id="http-enabled",
                    classes="checkbox",
                )
                http_checkbox.tooltip = "When disabled, `docket serve` stays off by default."
                yield http_checkbox
                yield Static("HTTP bind address", classes="field-label")
                yield Input(value=self._config.http.bind, placeholder="127.0.0.1", id="http-bind")
                yield Static("HTTP port", classes="field-label")
                yield Input(value=str(self._config.http.port), placeholder="8765", id="http-port")
                yield Static("HTTP bearer token", classes="field-label")
                yield Input(value=self._config.http.token, placeholder="token", id="http-token")
                telemetry_checkbox = Checkbox(
                    "Enable local telemetry logs",
                    value=self._config.telemetry.enabled,
                    id="telemetry-enabled",
                    classes="checkbox",
                )
                telemetry_checkbox.tooltip = "Telemetry stays local on disk."
                yield telemetry_checkbox
                yield Static("Telemetry log level", classes="field-label")
                level_options = [(lvl.value, lvl.value) for lvl in TelemetryLevel]
                level_select = Select(
                    options=level_options,
                    value=self._config.telemetry.level.value,
                    allow_blank=False,
                    id="telemetry-level",
                )
                level_select.tooltip = (
                    "DEBUG keeps every event; raise to reduce log volume. "
                    "Disabled when telemetry is off."
                )
                yield level_select
            yield Static("Ctrl+S save  ·  Esc cancel", id="hint")

    def on_mount(self) -> None:
        self.query_one("#scope-select", Select).focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id != "scope-select":
            return
        selected = event.value
        if selected is Select.BLANK or not isinstance(selected, str):
            return
        entry = self._active_entry
        scopes = entry.scopes if entry is not None else {}
        scope = scopes.get(selected, ScopeFilter())
        name_input = self.query_one("#scope-name", Input)
        default_checkbox = self.query_one("#scope-default", Checkbox)
        if selected == _NEW_SCOPE:
            name_input.value = ""
            default_checkbox.value = False
            scope = ScopeFilter()
        else:
            name_input.value = selected
            current_active = entry.active_scope if entry is not None else ""
            default_checkbox.value = current_active == selected
        self.query_one("#scope-team", Input).value = scope.team
        self.query_one("#scope-area", Input).value = scope.area_path
        self.query_one("#scope-iteration", Input).value = scope.iteration_path
        self.query_one("#scope-assignee", Input).value = scope.assignee

    def action_save(self) -> None:
        try:
            config = self._build_config()
        except ValueError as exc:
            self.app.notify(str(exc), severity="warning")
            return
        save_config(self._paths, config)
        self.dismiss(config)

    def action_cancel(self) -> None:
        self.dismiss(None)

    def _build_config(self) -> Config:
        raw = self._config.model_dump(mode="json")

        entry = self._active_entry
        provider_key = self._active_provider_key
        if entry is None or not provider_key:
            raise ValueError("No provider is active — add one via `docket setup provider add`.")

        scope_name = self.query_one("#scope-name", Input).value.strip()
        if not scope_name:
            raise ValueError("View name is required.")

        provider_raw = raw["providers"].setdefault(provider_key, {})
        provider_raw.setdefault("scopes", {})
        provider_raw["scopes"][scope_name] = {
            "team": self.query_one("#scope-team", Input).value.strip(),
            "area_path": self.query_one("#scope-area", Input).value.strip(),
            "iteration_path": self.query_one("#scope-iteration", Input).value.strip(),
            "assignee": self.query_one("#scope-assignee", Input).value.strip(),
        }
        if self.query_one("#scope-default", Checkbox).value:
            provider_raw["active_scope"] = scope_name

        display = self.query_one("#provider-display", Input).value.strip()
        if display:
            provider_raw["display_name"] = display

        provider_spec = registry.spec(entry.type)
        if provider_spec is not None and provider_spec.setup_fields:
            cfg: dict[str, Any] = dict(provider_raw.get("config", {}))
            for setup_field in provider_spec.setup_fields:
                widget = self.query_one(f"#provider-cfg-{setup_field.key}", Input)
                cfg[setup_field.key] = widget.value.strip()
            try:
                cfg = registry.normalize_config(entry.type, cfg)
            except ValueError as exc:
                raise ValueError(str(exc)) from exc
            provider_raw["config"] = cfg

        default_kind = self.query_one("#ui-default-kind", Select).value
        if default_kind is Select.BLANK:
            raise ValueError("Please choose the default new-item kind.")

        raw["llm"]["endpoint"] = self.query_one("#llm-endpoint", Input).value.strip() or None
        raw["llm"]["deployment"] = self.query_one("#llm-deployment", Input).value.strip()
        raw["llm"]["price_input_per_1m"] = _parse_optional_float(
            self.query_one("#llm-price-input", Input).value,
            field_name="Input price per 1M",
        )
        raw["llm"]["price_output_per_1m"] = _parse_optional_float(
            self.query_one("#llm-price-output", Input).value,
            field_name="Output price per 1M",
        )
        raw["http"]["enabled"] = self.query_one("#http-enabled", Checkbox).value
        raw["http"]["bind"] = self.query_one("#http-bind", Input).value.strip()
        raw["http"]["port"] = _parse_scalar(
            self.query_one("#http-port", Input).value, int, field_name="HTTP port"
        )
        raw["http"]["token"] = self.query_one("#http-token", Input).value.strip()
        raw["telemetry"]["enabled"] = self.query_one("#telemetry-enabled", Checkbox).value
        level_value = self.query_one("#telemetry-level", Select).value
        if isinstance(level_value, str):
            raw["telemetry"]["level"] = level_value
        raw["llm"]["compaction_threshold_tokens"] = _parse_scalar(
            self.query_one("#llm-compaction", Input).value,
            int,
            field_name="Compaction threshold",
        )
        raw["llm"]["external_watch_interval_seconds"] = _parse_scalar(
            self.query_one("#llm-watch", Input).value,
            float,
            field_name="External watch interval",
        )
        raw["ui"]["default_new_item_kind"] = default_kind
        raw["ui"]["show_acceptance_criteria"] = self.query_one("#ui-show-criteria", Checkbox).value
        raw["sync"]["background_interval_seconds"] = _parse_scalar(
            self.query_one("#sync-background", Input).value,
            float,
            field_name="Background sync interval",
        )
        raw["sync"]["min_interval_seconds_by_provider"] = _parse_map(
            self.query_one("#sync-min-overrides", Input).value,
            value_type="float",
        )
        raw["stale"]["threshold_days"] = _parse_scalar(
            self.query_one("#stale-threshold", Input).value,
            int,
            field_name="Stale threshold",
        )
        raw["stale"]["threshold_days_by_provider"] = _parse_map(
            self.query_one("#stale-overrides", Input).value,
            value_type="int",
        )

        return Config.model_validate(raw)
