"""`docket mcp ...` — manage per-project MCP server configs.

Each entry lives under `[projects.<id>.mcp.<name>]` in `config.toml` and
is exposed to the agent as `mcp__<name>__<tool>` once the running TUI /
HTTP server starts the client. The CLI is the source-of-truth editor;
the running server picks up changes on its next `bind_project` call (a
project switch, or a server restart).
"""

from __future__ import annotations

import typer
from rich.console import Console
from rich.table import Table

from docket.agent.mcp import MCPClient
from docket.cli.context import prepare_or_wizard
from docket.config.models import MCPServerEntry
from docket.core.services import mcp_service

console = Console()

mcp_app = typer.Typer(
    name="mcp",
    help="List, add, remove, and test MCP servers attached to the active project.",
    no_args_is_help=True,
)


def _split_args(raw: str | None) -> list[str]:
    """Split `--args` into a real argv list. Splits on whitespace; for paths
    with spaces, repeat the flag instead of relying on a single string."""
    if not raw:
        return []
    return [piece for piece in raw.split() if piece]


def _split_env(raw: list[str] | None) -> dict[str, str]:
    """Parse `--env KEY=VALUE` pairs into a dict. Repeatable flag."""
    if not raw:
        return {}
    out: dict[str, str] = {}
    for pair in raw:
        if "=" not in pair:
            raise typer.BadParameter(f"--env entry '{pair}' must be KEY=VALUE")
        key, _, value = pair.partition("=")
        if not key.strip():
            raise typer.BadParameter(f"--env entry '{pair}' has empty key")
        out[key.strip()] = value
    return out


@mcp_app.command("list")
def mcp_list() -> None:
    """List MCP servers configured for the active project."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        servers = mcp_service.list_servers(ctx.config, project.id)
        if not servers:
            console.print(
                f"[dim]No MCP servers for[/dim] [cyan]{project.name}[/cyan] "
                "[dim](try `docket mcp add`)[/dim]"
            )
            return
        table = Table(title=f"MCP · {project.name} ({len(servers)})")
        table.add_column("Name", style="cyan")
        table.add_column("Enabled", style="green")
        table.add_column("Transport", style="magenta")
        table.add_column("Command", style="yellow")
        table.add_column("Args", style="dim")
        table.add_column("Timeout", style="dim", justify="right")
        for name, entry in servers.items():
            table.add_row(
                name,
                "yes" if entry.enabled else "no",
                entry.transport,
                entry.command or "—",
                " ".join(entry.args),
                f"{entry.startup_timeout_seconds:.1f}s",
            )
        console.print(table)
    finally:
        ctx.close()


@mcp_app.command("add")
def mcp_add(
    name: str = typer.Argument(..., help="Short name. Becomes the `mcp__<name>__*` tool prefix."),
    command: str = typer.Option(..., "--command", help="Executable to spawn (stdio transport)."),
    args: str | None = typer.Option(
        None, "--args", help="Whitespace-separated args. Repeat the flag for spaces in paths."
    ),
    env: list[str] | None = typer.Option(None, "--env", help="KEY=VALUE env override. Repeatable."),
    enabled: bool = typer.Option(True, "--enabled/--disabled", help="Start the server on bind."),
    timeout: float = typer.Option(
        10.0, "--timeout", help="Seconds to wait for the initial handshake."
    ),
) -> None:
    """Add a new MCP server entry to the active project."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        try:
            mcp_service.add_server(
                ctx.config,
                ctx.paths,
                project.id,
                name,
                command=command,
                args=_split_args(args),
                env=_split_env(env),
                enabled=enabled,
                startup_timeout_seconds=timeout,
            )
        except mcp_service.DuplicateServerError as exc:
            console.print(
                f"[red]Server '{name}' already exists for[/red] [cyan]{project.name}[/cyan] "
                "[dim](use `docket mcp rm` first, or edit `config.toml`).[/dim]"
            )
            raise typer.Exit(1) from exc
        except mcp_service.InvalidServerConfigError as exc:
            console.print(f"[red]Invalid MCP config:[/red] {exc}")
            raise typer.Exit(1) from exc
        console.print(
            f"[green]Added[/green] MCP server [cyan]{name}[/cyan] to "
            f"[cyan]{project.name}[/cyan]. [dim]Restart `docket serve`/the TUI to load it.[/dim]"
        )
    finally:
        ctx.close()


@mcp_app.command("presets")
def mcp_presets() -> None:
    """List known MCP server presets (`docket mcp add-preset <id>`)."""
    from docket.config.mcp_presets import list_presets

    presets = list_presets()
    if not presets:
        console.print("[dim]No presets registered.[/dim]")
        return
    table = Table(title=f"MCP presets ({len(presets)})")
    table.add_column("Id", style="cyan")
    table.add_column("Label", style="green")
    # Env var names can be long (GITHUB_PERSONAL_ACCESS_TOKEN); don't let
    # Rich wrap them in the middle of the token — apply scripts grep the
    # output for the full var name.
    table.add_column("Env vars", style="yellow", no_wrap=True)
    table.add_column("Description", style="dim")
    for preset in presets:
        env_names = ", ".join(var.name for var in preset.env) or "—"
        table.add_row(preset.id, preset.label, env_names, preset.description)
    console.print(table)


@mcp_app.command("add-preset")
def mcp_add_preset(
    preset_id: str = typer.Argument(..., help="Preset id (run `docket mcp presets` to list)."),
    name: str | None = typer.Option(
        None,
        "--name",
        help="Override the server name. Defaults to the preset's own default.",
    ),
    env: list[str] | None = typer.Option(
        None,
        "--env",
        help="KEY=VALUE for the preset's required env vars. Repeatable.",
    ),
    enabled: bool = typer.Option(True, "--enabled/--disabled", help="Start on bind."),
) -> None:
    """Add an MCP server from a known preset.

    The preset defines the `command`, `args`, and transport; you only supply
    the env values (typically an API token). `docket mcp presets` lists the
    env vars each preset needs."""
    from docket.config.mcp_presets import (
        MissingPresetEnvError,
        UnknownPresetError,
    )

    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        try:
            server_name, _ = mcp_service.add_server_from_preset(
                ctx.config,
                ctx.paths,
                project.id,
                preset_id,
                name=name,
                env=_split_env(env),
                enabled=enabled,
            )
        except UnknownPresetError as exc:
            console.print(
                f"[red]Unknown preset '{preset_id}'.[/red] "
                "[dim]Run `docket mcp presets` to see the list.[/dim]"
            )
            raise typer.Exit(1) from exc
        except MissingPresetEnvError as exc:
            console.print(f"[red]Missing env value:[/red] {exc}")
            console.print("[dim]Pass it with `--env KEY=VALUE` (repeatable).[/dim]")
            raise typer.Exit(1) from exc
        except mcp_service.DuplicateServerError as exc:
            console.print(
                f"[red]Server '{server_name if name is None else name}' already exists.[/red] "
                "[dim](use `docket mcp rm` first, or pass `--name` to add another instance).[/dim]"
            )
            raise typer.Exit(1) from exc
        except mcp_service.InvalidServerConfigError as exc:
            console.print(f"[red]Invalid MCP config:[/red] {exc}")
            raise typer.Exit(1) from exc
        console.print(
            f"[green]Added[/green] MCP preset [cyan]{preset_id}[/cyan] as "
            f"[cyan]{server_name}[/cyan] on [cyan]{project.name}[/cyan]. "
            "[dim]Restart `docket serve`/the TUI to load it.[/dim]"
        )
    finally:
        ctx.close()


@mcp_app.command("rm")
def mcp_rm(
    name: str = typer.Argument(..., help="Server name to remove."),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt."),
) -> None:
    """Remove an MCP server entry from the active project."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        try:
            mcp_service.get_server(ctx.config, project.id, name)
        except mcp_service.UnknownServerError as exc:
            console.print(
                f"[red]No MCP server named '{name}' on[/red] [cyan]{project.name}[/cyan]."
            )
            raise typer.Exit(1) from exc
        if not yes:
            confirmed = typer.confirm(
                f"Delete MCP server '{name}' from '{project.name}'?", default=False
            )
            if not confirmed:
                console.print("[dim]Cancelled.[/dim]")
                raise typer.Exit(1)
        mcp_service.remove_server(ctx.config, ctx.paths, project.id, name)
        console.print(f"[yellow]Removed[/yellow] MCP server [cyan]{name}[/cyan].")
    finally:
        ctx.close()


@mcp_app.command("enable")
def mcp_enable(
    name: str = typer.Argument(..., help="Server name to enable."),
) -> None:
    """Mark an MCP server entry as enabled (started on next bind)."""
    _set_enabled(name, True)


@mcp_app.command("disable")
def mcp_disable(
    name: str = typer.Argument(..., help="Server name to disable."),
) -> None:
    """Mark an MCP server entry as disabled (kept in config, not started)."""
    _set_enabled(name, False)


def _set_enabled(name: str, enabled: bool) -> None:
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        try:
            mcp_service.update_server(ctx.config, ctx.paths, project.id, name, enabled=enabled)
        except mcp_service.UnknownServerError as exc:
            console.print(
                f"[red]No MCP server named '{name}' on[/red] [cyan]{project.name}[/cyan]."
            )
            raise typer.Exit(1) from exc
        except mcp_service.InvalidServerConfigError as exc:
            console.print(f"[red]Invalid MCP config:[/red] {exc}")
            raise typer.Exit(1) from exc
        verb = "[green]Enabled[/green]" if enabled else "[yellow]Disabled[/yellow]"
        console.print(f"{verb} MCP server [cyan]{name}[/cyan] on [cyan]{project.name}[/cyan].")
    finally:
        ctx.close()


@mcp_app.command("test")
def mcp_test(
    name: str = typer.Argument(..., help="Server name to test."),
) -> None:
    """Briefly start the MCP server, list its tools, then close.

    Spawns the configured command, completes the handshake, prints the
    discovered tool catalog, and tears the subprocess back down. Useful
    for verifying a fresh `add` before the running app reloads."""
    ctx = prepare_or_wizard()
    try:
        project = ctx.active_project()
        try:
            entry = mcp_service.get_server(ctx.config, project.id, name)
        except mcp_service.UnknownServerError as exc:
            console.print(
                f"[red]No MCP server named '{name}' on[/red] [cyan]{project.name}[/cyan]."
            )
            raise typer.Exit(1) from exc
        try:
            entry = mcp_service.validate_entry(entry)
        except mcp_service.InvalidServerConfigError as exc:
            console.print(f"[red]Invalid MCP config:[/red] {exc}")
            raise typer.Exit(1) from exc
        if not entry.command:
            console.print(f"[red]Server '{name}' has no `command` configured.[/red]")
            raise typer.Exit(1)
    finally:
        ctx.close()

    client = MCPClient(name, entry)
    try:
        client.start()
    except Exception as exc:
        console.print(f"[red]Failed to start MCP server '{name}':[/red] {exc}")
        client.close()
        raise typer.Exit(1) from exc
    try:
        tools = client.list_tools()
        console.print(
            f"[green]Connected[/green] to [cyan]{name}[/cyan] "
            f"({len(tools)} tool{'s' if len(tools) != 1 else ''}):"
        )
        if not tools:
            console.print("  [dim](server reported no tools)[/dim]")
        for tool in sorted(tools, key=lambda t: t.name):
            description = (tool.description or "").splitlines()[0] if tool.description else ""
            console.print(f"  [yellow]mcp__{name}__{tool.name}[/yellow]  [dim]{description}[/dim]")
    finally:
        client.close()


def _entry_to_summary(name: str, entry: MCPServerEntry) -> str:
    """Used by tests / pretty-printers to format an entry on a single line."""
    state = "on" if entry.enabled else "off"
    return f"{name} [{state}] {entry.command} {' '.join(entry.args)}".strip()


__all__ = ["mcp_app"]
