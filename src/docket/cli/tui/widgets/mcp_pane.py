"""Per-project MCP server editor modal.

Two-column layout: a list of configured MCP servers on the left, a form
editor on the right. Add/remove/save edit `[projects.<id>.mcp.<name>]` in
`config.toml` via `mcp_service`; Test briefly spawns the configured
subprocess to confirm the handshake works before relying on it.

Saves rebind the live `MCPManager` immediately so the running agent
picks up the change on its next turn. The modal dismisses with `True`
when anything has been written so the parent app can rebuild the agent
once the modal closes; pilot tests passing `mcp_manager=None` get the
config edits without the live-fleet side effects.

Server names are immutable once created — renaming would change the
exposed `mcp__<name>__*` tool ids and surprise any in-flight chat
state. Delete + re-add if a name needs to change.
"""

from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Checkbox, Input, ListItem, ListView, Static, TextArea

from docket.agent.mcp import MCPClient, MCPManager
from docket.config.models import Config, MCPServerEntry
from docket.config.paths import Paths
from docket.core.services import mcp_service


class _ServerRow(ListItem):
    """ListItem that carries the underlying server name."""

    def __init__(self, name: str, entry: MCPServerEntry) -> None:
        state = "on " if entry.enabled else "off"
        label = f"[{state}] {name}"
        super().__init__(Static(label))
        self.server_name = name


def _format_env(env: dict[str, str]) -> str:
    return "\n".join(f"{k}={v}" for k, v in env.items())


def _parse_env(raw: str) -> dict[str, str]:
    """Parse the env TextArea (KEY=VALUE per line). Blank lines ignored.
    Raises ValueError on malformed lines so the caller can surface the
    exact line number to the user."""
    env: dict[str, str] = {}
    for index, line in enumerate(raw.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        if "=" not in stripped:
            raise ValueError(f"line {index}: '{stripped}' must be KEY=VALUE")
        key, _, value = stripped.partition("=")
        key = key.strip()
        if not key:
            raise ValueError(f"line {index}: '{stripped}' has empty key")
        env[key] = value
    return env


def _parse_args(raw: str) -> list[str]:
    """Whitespace-split args. Mirrors the CLI's `_split_args`."""
    return [piece for piece in raw.split() if piece]


class MCPPane(ModalScreen[bool]):
    """Modal for browsing and editing the active project's MCP server fleet.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't
    try to track scope switches."""

    DEFAULT_CSS = """
    MCPPane { align: center middle; }
    MCPPane > Vertical {
        width: 120;
        max-width: 150;
        height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    MCPPane #title { height: auto; color: $accent; text-style: bold; }
    MCPPane #subtitle { height: auto; color: $text-muted; padding-bottom: 1; }
    MCPPane #body { height: 1fr; }
    MCPPane #list-col { width: 38; }
    MCPPane #editor-col { width: 1fr; padding-left: 2; }
    MCPPane #servers { height: 1fr; border: round $panel-lighten-1; }
    MCPPane .field-label { height: auto; color: $text-muted; padding-top: 1; }
    MCPPane #name-input { height: 3; }
    MCPPane #command-input { height: 3; }
    MCPPane #args-input { height: 3; }
    MCPPane #transport-input { height: 3; }
    MCPPane #timeout-input { height: 3; }
    MCPPane #env-input { height: 8; border: round $panel-lighten-1; background: $panel; }
    MCPPane #enabled-checkbox { height: 3; padding-top: 1; }
    MCPPane #buttons { height: auto; padding-top: 1; }
    MCPPane #buttons Button { margin-right: 1; }
    MCPPane #hint { height: auto; color: $text-muted; padding-top: 1; }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+n", "new_entry", "New", priority=True),
        Binding("ctrl+t", "test", "Test", priority=True),
        Binding("ctrl+d", "delete", "Delete", priority=True),
        Binding("escape", "cancel", "Close", priority=True),
    ]

    def __init__(
        self,
        *,
        paths: Paths,
        config: Config,
        project_id: str,
        project_name: str,
        mcp_manager: MCPManager | None = None,
        read_only: bool = False,
    ) -> None:
        super().__init__()
        self._paths = paths
        self._config = config
        self._project_id = project_id
        self._project_name = project_name
        self._mcp_manager = mcp_manager
        self._read_only = read_only
        self._entries: dict[str, MCPServerEntry] = {}
        self._current_name: str | None = None  # None = unsaved/new
        self._dirty = False  # any successful write since open?

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(f"MCP · {self._project_name}", id="title")
            yield Static(
                "Per-project MCP servers exposed to the agent as "
                "`mcp__<name>__<tool>`. Save rebinds the live fleet; "
                "Test spawns the subprocess and lists its tools.",
                id="subtitle",
            )
            with Horizontal(id="body"):
                with Vertical(id="list-col"):
                    yield Static("servers", classes="field-label")
                    yield ListView(id="servers")
                with Vertical(id="editor-col"):
                    yield Static("name (immutable after create)", classes="field-label")
                    yield Input(placeholder="short identifier…", id="name-input")
                    yield Static("command", classes="field-label")
                    yield Input(placeholder="/usr/bin/python or absolute path", id="command-input")
                    yield Static("args (whitespace-separated)", classes="field-label")
                    yield Input(placeholder="-m my.server --flag", id="args-input")
                    yield Static("env (KEY=VALUE per line)", classes="field-label")
                    yield TextArea("", id="env-input")
                    yield Static("transport", classes="field-label")
                    yield Input(value="stdio", placeholder="stdio", id="transport-input")
                    yield Static("startup timeout (seconds)", classes="field-label")
                    yield Input(value="10.0", placeholder="10.0", id="timeout-input")
                    yield Checkbox("Enabled (start on bind)", value=True, id="enabled-checkbox")
                    with Horizontal(id="buttons"):
                        yield Button("Save", id="save-btn", variant="primary")
                        yield Button("New", id="new-btn")
                        yield Button("Test", id="test-btn")
                        yield Button("Delete", id="delete-btn", variant="error")
                        yield Button("Close", id="close-btn")
            yield Static(
                "Ctrl+S save  ·  Ctrl+N new  ·  Ctrl+T test  ·  Ctrl+D delete  ·  Esc close",
                id="hint",
            )

    def on_mount(self) -> None:
        self._reload_entries(select_name=None)
        if self._read_only:
            self._set_editor_enabled(False)
            self.app.notify("Read-only mode — MCP edits are disabled.", severity="warning")

    # -- list management ---------------------------------------------------

    def _reload_entries(self, *, select_name: str | None) -> None:
        self._entries = mcp_service.list_servers(self._config, self._project_id)
        view = self.query_one("#servers", ListView)
        view.clear()
        for name, entry in self._entries.items():
            view.append(_ServerRow(name, entry))
        names = list(self._entries)
        if select_name is not None and select_name in self._entries:
            view.index = names.index(select_name)
            self._load_into_editor(select_name, self._entries[select_name])
            return
        if names:
            view.index = 0
            first = names[0]
            self._load_into_editor(first, self._entries[first])
        else:
            self._clear_editor()

    def _load_into_editor(self, name: str, entry: MCPServerEntry) -> None:
        self._current_name = name
        name_input = self.query_one("#name-input", Input)
        name_input.value = name
        # Names are immutable after create — disable the field so the user
        # doesn't accidentally type a new value and expect a rename.
        name_input.disabled = True
        self.query_one("#command-input", Input).value = entry.command
        self.query_one("#args-input", Input).value = " ".join(entry.args)
        self.query_one("#env-input", TextArea).text = _format_env(entry.env)
        self.query_one("#transport-input", Input).value = entry.transport
        self.query_one("#timeout-input", Input).value = f"{entry.startup_timeout_seconds}"
        self.query_one("#enabled-checkbox", Checkbox).value = entry.enabled

    def _clear_editor(self) -> None:
        self._current_name = None
        name_input = self.query_one("#name-input", Input)
        name_input.value = ""
        # Editable for new-entry creation.
        name_input.disabled = self._read_only
        self.query_one("#command-input", Input).value = ""
        self.query_one("#args-input", Input).value = ""
        self.query_one("#env-input", TextArea).text = ""
        self.query_one("#transport-input", Input).value = "stdio"
        self.query_one("#timeout-input", Input).value = "10.0"
        self.query_one("#enabled-checkbox", Checkbox).value = True

    def _set_editor_enabled(self, enabled: bool) -> None:
        for widget_id in (
            "name-input",
            "command-input",
            "args-input",
            "env-input",
            "transport-input",
            "timeout-input",
            "enabled-checkbox",
        ):
            self.query_one(f"#{widget_id}").disabled = not enabled
        for btn_id in ("save-btn", "new-btn", "test-btn", "delete-btn"):
            self.query_one(f"#{btn_id}", Button).disabled = not enabled

    # -- events ------------------------------------------------------------

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, _ServerRow):
            entry = self._entries.get(item.server_name)
            if entry is not None:
                self._load_into_editor(item.server_name, entry)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save-btn":
            self.action_save()
        elif event.button.id == "new-btn":
            self.action_new_entry()
        elif event.button.id == "test-btn":
            self.action_test()
        elif event.button.id == "delete-btn":
            self.action_delete()
        elif event.button.id == "close-btn":
            self.action_cancel()

    # -- actions -----------------------------------------------------------

    def action_new_entry(self) -> None:
        if self._read_only:
            return
        self._clear_editor()
        self.query_one("#name-input", Input).focus()

    def action_save(self) -> None:
        if self._read_only:
            return
        form = self._read_form()
        if form is None:
            return  # validation error already notified
        name, command, args, env, transport, enabled, timeout = form
        try:
            if self._current_name is None:
                mcp_service.add_server(
                    self._config,
                    self._paths,
                    self._project_id,
                    name,
                    command=command,
                    args=args,
                    env=env,
                    transport=transport,
                    enabled=enabled,
                    startup_timeout_seconds=timeout,
                )
                self.app.notify(f"Added MCP server '{name}'.", severity="information")
            else:
                mcp_service.update_server(
                    self._config,
                    self._paths,
                    self._project_id,
                    self._current_name,
                    command=command,
                    args=args,
                    env=env,
                    transport=transport,
                    enabled=enabled,
                    startup_timeout_seconds=timeout,
                )
                self.app.notify(f"Saved MCP server '{name}'.", severity="information")
        except mcp_service.DuplicateServerError:
            self.app.notify(f"'{name}' already exists.", severity="error")
            return
        except mcp_service.InvalidServerConfigError as exc:
            self.app.notify(str(exc), severity="error")
            return
        except mcp_service.UnknownServerError:
            self.app.notify(f"'{name}' vanished — refreshing.", severity="warning")
            self._reload_entries(select_name=None)
            return
        self._dirty = True
        self._rebind_live_fleet()
        self._reload_entries(select_name=name)

    def action_delete(self) -> None:
        if self._read_only or self._current_name is None:
            return
        name = self._current_name
        try:
            mcp_service.remove_server(self._config, self._paths, self._project_id, name)
        except mcp_service.UnknownServerError:
            # Already gone; just refresh the list to stay consistent.
            self._reload_entries(select_name=None)
            return
        self.app.notify(f"Removed MCP server '{name}'.", severity="information")
        self._dirty = True
        self._rebind_live_fleet()
        self._reload_entries(select_name=None)

    def action_test(self) -> None:
        """Spawn the in-editor server briefly, list its tools, then close.
        Runs in a worker thread because `MCPClient.start` blocks on the
        handshake (up to `startup_timeout_seconds`)."""
        if self._read_only:
            return
        form = self._read_form()
        if form is None:
            return
        name, command, args, env, transport, enabled, timeout = form
        if not command:
            self.app.notify("Set a command before testing.", severity="warning")
            return
        # Build a transient entry from the in-editor values so the user
        # can verify changes before pressing Save.
        entry = MCPServerEntry(
            transport=transport,
            command=command,
            args=args,
            env=env,
            enabled=enabled,
            startup_timeout_seconds=timeout,
        )
        try:
            entry = mcp_service.validate_entry(entry)
        except mcp_service.InvalidServerConfigError as exc:
            self.app.notify(str(exc), severity="error")
            return
        self.app.notify(f"Starting MCP server '{name}'…", severity="information")
        self.run_worker(
            lambda: self._test_worker(name, entry),
            group=f"mcp-test-{name}",
            exclusive=True,
            thread=True,
        )

    def _test_worker(self, name: str, entry: MCPServerEntry) -> None:
        client = MCPClient(name, entry)
        try:
            client.start()
        except Exception as exc:
            client.close()
            message = f"MCP test '{name}' failed: {exc}"
            self.app.call_from_thread(lambda: self.app.notify(message, severity="error"))
            return
        try:
            tools = sorted(client.list_tools(), key=lambda t: t.name)
        finally:
            client.close()
        if not tools:
            summary = f"MCP test '{name}' OK · server reported no tools."
        else:
            preview = ", ".join(f"mcp__{name}__{t.name}" for t in tools[:3])
            extra = "" if len(tools) <= 3 else f" (+{len(tools) - 3} more)"
            summary = (
                f"MCP test '{name}' OK · {len(tools)} tool"
                f"{'' if len(tools) == 1 else 's'}: {preview}{extra}"
            )
        self.app.call_from_thread(lambda: self.app.notify(summary, severity="information"))

    def action_cancel(self) -> None:
        # Signal the parent app whether anything was committed so it knows
        # to rebuild the agent. Pilot tests without an mcp_manager still
        # get the dismiss signal so they can assert.
        self.dismiss(self._dirty)

    # -- helpers -----------------------------------------------------------

    def _read_form(
        self,
    ) -> tuple[str, str, list[str], dict[str, str], str, bool, float] | None:
        """Read + validate the editor form. Notifies on error and returns
        `None` so callers can early-exit."""
        name = self.query_one("#name-input", Input).value.strip()
        command = self.query_one("#command-input", Input).value.strip()
        args_raw = self.query_one("#args-input", Input).value
        env_raw = self.query_one("#env-input", TextArea).text
        transport = self.query_one("#transport-input", Input).value.strip() or "stdio"
        timeout_raw = self.query_one("#timeout-input", Input).value.strip()
        enabled = self.query_one("#enabled-checkbox", Checkbox).value
        if not name:
            self.app.notify("Name is required.", severity="warning")
            return None
        if not command:
            self.app.notify("Command is required.", severity="warning")
            return None
        try:
            env = _parse_env(env_raw)
        except ValueError as exc:
            self.app.notify(f"env: {exc}", severity="error")
            return None
        try:
            timeout = float(timeout_raw) if timeout_raw else 10.0
        except ValueError:
            self.app.notify(f"timeout '{timeout_raw}' is not a number.", severity="error")
            return None
        if timeout <= 0:
            self.app.notify("timeout must be > 0.", severity="warning")
            return None
        return name, command, _parse_args(args_raw), env, transport, enabled, timeout

    def _rebind_live_fleet(self) -> None:
        """Push the latest `[projects.<pid>.mcp]` snapshot into the running
        manager so the agent picks up the change. The agent rebuild itself
        is deferred to the parent app on dismiss to keep one source of
        truth for `build_agent` arguments."""
        manager = self._mcp_manager
        if manager is None:
            return
        project = self._config.projects.get(self._project_id)
        servers = dict(project.mcp) if project is not None else {}
        manager.bind_project(self._project_id, servers)


__all__ = ["MCPPane"]
