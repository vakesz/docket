"""Per-project MCP server editor modal — extends `ListEditPane`.

Two-column layout: configured servers on the left, form editor on the
right. Add/remove/save edit `[projects.<id>.mcp.<name>]` in `config.toml`
via `mcp_service`; Test briefly spawns the configured subprocess to
confirm the handshake works before relying on it.

Saves rebind the live `MCPManager` immediately so the running agent picks
up the change on its next turn. The modal dismisses with `True` when
anything has been written so the parent app can rebuild the agent once
the modal closes; pilot tests passing `mcp_manager=None` get the config
edits without the live-fleet side effects.

Server names are immutable once created — renaming would change the
exposed `mcp__<name>__*` tool ids and surprise any in-flight chat state.
Delete + re-add if a name needs to change."""

from __future__ import annotations

from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.widgets import Button, Checkbox, Input, Static, TextArea

from docket.agent.mcp import MCPClient, MCPManager
from docket.cli.tui.widgets._list_edit_pane import ListEditPane
from docket.config.models import Config, MCPServerEntry
from docket.config.paths import Paths
from docket.core.services import mcp_service


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


class MCPPane(ListEditPane):
    """Modal for browsing and editing the active project's MCP server fleet.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't try
    to track scope switches."""

    DEFAULT_CSS = """
    MCPPane > Vertical { width: 120; max-width: 150; }
    MCPPane #name-input { height: 3; }
    MCPPane #command-input { height: 3; }
    MCPPane #args-input { height: 3; }
    MCPPane #transport-input { height: 3; }
    MCPPane #timeout-input { height: 3; }
    MCPPane #env-input { height: 8; border: round $panel-lighten-1; background: $panel; }
    MCPPane #enabled-checkbox { height: 3; padding-top: 1; }
    """

    BINDINGS: ClassVar[list[BindingType]] = [
        *ListEditPane.BINDINGS,
        Binding("ctrl+t", "test", "Test", priority=True),
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
        super().__init__(read_only=read_only)
        self._paths = paths
        self._config = config
        self._project_id = project_id
        self._mcp_manager = mcp_manager
        self._title = f"MCP · {project_name}"
        self._subtitle = (
            "Per-project MCP servers exposed to the agent as "
            "`mcp__<name>__<tool>`. Save rebinds the live fleet; "
            "Test spawns the subprocess and lists its tools."
        )
        self._hint = "Ctrl+S save  ·  Ctrl+N new  ·  Ctrl+T test  ·  Ctrl+D delete  ·  Esc close"

    # ListEditRow uses entry_id as the immutable lookup key, which doubles
    # as the server name here. Aliasing keeps the existing pilot tests'
    # `_current_name` assertions working without piping a second attribute
    # through the primitive.
    @property
    def _current_name(self) -> str | None:
        return self._current_id

    def compose_editor(self) -> ComposeResult:
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

    def compose_buttons(self) -> ComposeResult:
        yield Button("Save", id="save-btn", variant="primary")
        yield Button("New", id="new-btn")
        yield Button("Test", id="test-btn")
        yield Button("Delete", id="delete-btn", variant="error")
        yield Button("Close", id="close-btn")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "test-btn":
            self.action_test()
            return
        super().on_button_pressed(event)

    def _field_ids(self) -> tuple[str, ...]:
        return (
            "name-input",
            "command-input",
            "args-input",
            "env-input",
            "transport-input",
            "timeout-input",
            "enabled-checkbox",
        )

    # -- ListEditPane hooks -----------------------------------------------

    def _list_rows(self) -> list[tuple[str, str]]:
        servers = mcp_service.list_servers(self._config, self._project_id)
        return [
            (name, f"[{'on ' if entry.enabled else 'off'}] {name}")
            for name, entry in servers.items()
        ]

    def _on_select(self, entry_id: str) -> None:
        servers = mcp_service.list_servers(self._config, self._project_id)
        entry = servers.get(entry_id)
        if entry is None:
            return
        self._current_id = entry_id
        name_input = self.query_one("#name-input", Input)
        name_input.value = entry_id
        # Names are immutable after create — disable so the user doesn't
        # accidentally type a new value and expect a rename.
        name_input.disabled = True
        self.query_one("#command-input", Input).value = entry.command
        self.query_one("#args-input", Input).value = " ".join(entry.args)
        self.query_one("#env-input", TextArea).text = _format_env(entry.env)
        self.query_one("#transport-input", Input).value = entry.transport
        self.query_one("#timeout-input", Input).value = f"{entry.startup_timeout_seconds}"
        self.query_one("#enabled-checkbox", Checkbox).value = entry.enabled

    def _clear_form(self) -> None:
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

    def _save(self) -> str | None:
        form = self._read_form()
        if form is None:
            return None
        name, command, args, env, transport, enabled, timeout = form
        try:
            if self._current_id is None:
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
                    self._current_id,
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
            return None
        except mcp_service.InvalidServerConfigError as exc:
            self.app.notify(str(exc), severity="error")
            return None
        except mcp_service.UnknownServerError:
            self.app.notify(f"'{name}' vanished — refreshing.", severity="warning")
            return None
        self._rebind_live_fleet()
        return name

    def _delete_one(self, entry_id: str) -> bool:
        try:
            mcp_service.remove_server(self._config, self._paths, self._project_id, entry_id)
        except mcp_service.UnknownServerError:
            return False
        self.app.notify(f"Removed MCP server '{entry_id}'.", severity="information")
        self._rebind_live_fleet()
        return True

    # -- Test action -------------------------------------------------------

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
