from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Checkbox, Input, Select, Static

from docket.config.loader import save_config
from docket.config.models import Config, ScopeFilter
from docket.config.paths import Paths

_NEW_SCOPE = "__new__"


def _parse_float(raw: str, *, field_name: str) -> float:
    text = raw.strip()
    try:
        return float(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a number.") from exc


def _parse_int(raw: str, *, field_name: str) -> int:
    text = raw.strip()
    try:
        return int(text)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an integer.") from exc


def _parse_map(raw: str, *, value_type: str) -> dict[str, float] | dict[str, int]:
    text = raw.strip()
    if not text:
        return {}
    if value_type == "float":
        result: dict[str, float] = {}
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
            result[provider] = _parse_float(value, field_name=f"{provider} override")
        return result

    result_int: dict[str, int] = {}
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
        result_int[provider] = _parse_int(value, field_name=f"{provider} override")
    return result_int


def _format_map(raw: dict[str, float] | dict[str, int]) -> str:
    return ", ".join(f"{key}={value}" for key, value in raw.items())


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

    def compose(self) -> ComposeResult:
        scope_options = [("Create new view…", _NEW_SCOPE)]
        scope_options.extend((name, name) for name in sorted(self._config.scopes))
        active_scope = self._config.active_scope if self._config.active_scope in self._config.scopes else _NEW_SCOPE
        current_scope = self._config.scopes.get(self._config.active_scope, ScopeFilter())
        with Vertical():
            yield Static("Settings", id="title")
            yield Static(
                "Saved to config.toml. Visual behavior updates in this session; provider connection changes apply on the next launch.",
                id="subtitle",
            )
            with VerticalScroll():
                yield Static("Views & scope", classes="section")
                yield Static("saved view", classes="field-label")
                scope_picker = Select(
                    options=scope_options,
                    value=active_scope,
                    prompt="pick a saved view",
                    id="scope-select",
                )
                scope_picker.tooltip = "Choose a saved view to edit, or create a new one."
                yield scope_picker
                yield Static("view name", classes="field-label")
                yield Input(value=self._config.active_scope, placeholder="view name", id="scope-name")
                default_checkbox = Checkbox(
                    "Make this the default view",
                    value=True,
                    id="scope-default",
                    classes="checkbox",
                )
                default_checkbox.tooltip = "When enabled, Docket opens this view by default."
                yield default_checkbox
                yield Static("team", classes="field-label")
                yield Input(value=current_scope.team, placeholder="team (optional)", id="scope-team")
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
                    placeholder="@me or email",
                    id="scope-assignee",
                )

                yield Static("Provider & model", classes="section")
                yield Static("organization URL", classes="field-label")
                yield Input(
                    value=str(self._config.ado.organization),
                    placeholder="https://dev.azure.com/your-org",
                    id="ado-org",
                )
                yield Static("project", classes="field-label")
                yield Input(value=self._config.ado.project, placeholder="project name", id="ado-project")
                yield Static("description format", classes="field-label")
                yield Select(
                    options=[
                        ("Markdown", "markdown"),
                        ("HTML fallback", "html_fallback"),
                    ],
                    value=self._config.ado.description_format,
                    prompt="description format",
                    id="ado-description-format",
                )
                yield Static("Foundry endpoint", classes="field-label")
                yield Input(
                    value=str(self._config.foundry.endpoint or ""),
                    placeholder="https://your-foundry.openai.azure.com/",
                    id="foundry-endpoint",
                )
                yield Static("Foundry deployment", classes="field-label")
                yield Input(
                    value=self._config.foundry.deployment,
                    placeholder="gpt-5",
                    id="foundry-deployment",
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
            yield Static("Ctrl+S save  ·  Esc cancel", id="hint")

    def on_mount(self) -> None:
        self.query_one("#scope-select", Select).focus()

    def on_select_changed(self, event: Select.Changed) -> None:
        if event.select.id != "scope-select":
            return
        selected = event.value
        if selected is Select.BLANK:
            return
        assert isinstance(selected, str)
        scope = self._config.scopes.get(selected, ScopeFilter())
        name_input = self.query_one("#scope-name", Input)
        default_checkbox = self.query_one("#scope-default", Checkbox)
        if selected == _NEW_SCOPE:
            name_input.value = ""
            default_checkbox.value = False
            scope = ScopeFilter()
        else:
            name_input.value = selected
            default_checkbox.value = self._config.active_scope == selected
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

        scope_name = self.query_one("#scope-name", Input).value.strip()
        if not scope_name:
            raise ValueError("View name is required.")
        raw["scopes"][scope_name] = {
            "team": self.query_one("#scope-team", Input).value.strip(),
            "area_path": self.query_one("#scope-area", Input).value.strip(),
            "iteration_path": self.query_one("#scope-iteration", Input).value.strip(),
            "assignee": self.query_one("#scope-assignee", Input).value.strip() or "@me",
        }
        if self.query_one("#scope-default", Checkbox).value:
            raw["active_scope"] = scope_name

        description_format = self.query_one("#ado-description-format", Select).value
        default_kind = self.query_one("#ui-default-kind", Select).value
        if description_format is Select.BLANK or default_kind is Select.BLANK:
            raise ValueError("Please choose both the description format and default new-item kind.")

        raw["ado"]["organization"] = self.query_one("#ado-org", Input).value.strip()
        raw["ado"]["project"] = self.query_one("#ado-project", Input).value.strip()
        raw["ado"]["description_format"] = description_format
        raw["foundry"]["endpoint"] = self.query_one("#foundry-endpoint", Input).value.strip() or None
        raw["foundry"]["deployment"] = self.query_one("#foundry-deployment", Input).value.strip()
        raw["http"]["enabled"] = self.query_one("#http-enabled", Checkbox).value
        raw["http"]["bind"] = self.query_one("#http-bind", Input).value.strip()
        raw["http"]["port"] = _parse_int(self.query_one("#http-port", Input).value, field_name="HTTP port")
        raw["http"]["token"] = self.query_one("#http-token", Input).value.strip()
        raw["telemetry"]["enabled"] = self.query_one("#telemetry-enabled", Checkbox).value
        raw["llm"]["compaction_threshold_tokens"] = _parse_int(
            self.query_one("#llm-compaction", Input).value,
            field_name="Compaction threshold",
        )
        raw["llm"]["external_watch_interval_seconds"] = _parse_float(
            self.query_one("#llm-watch", Input).value,
            field_name="External watch interval",
        )
        raw["ui"]["default_new_item_kind"] = default_kind
        raw["ui"]["show_acceptance_criteria"] = self.query_one("#ui-show-criteria", Checkbox).value
        raw["sync"]["background_interval_seconds"] = _parse_float(
            self.query_one("#sync-background", Input).value,
            field_name="Background sync interval",
        )
        raw["sync"]["min_interval_seconds_by_provider"] = _parse_map(
            self.query_one("#sync-min-overrides", Input).value,
            value_type="float",
        )
        raw["stale"]["threshold_days"] = _parse_int(
            self.query_one("#stale-threshold", Input).value,
            field_name="Stale threshold",
        )
        raw["stale"]["threshold_days_by_provider"] = _parse_map(
            self.query_one("#stale-overrides", Input).value,
            value_type="int",
        )

        return Config.model_validate(raw)
