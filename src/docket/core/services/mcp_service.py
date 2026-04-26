"""Per-project MCP server config CRUD.

MCP servers live under `[projects.<id>.mcp.<name>]` in `config.toml` —
this module is the single writer for that section. Surfaces (CLI, HTTP,
TUI) call `add` / `update` / `remove` here so behavior stays uniform and
the on-disk layout has one well-tested code path.

The service does not touch the live `MCPManager`; rebinding the running
fleet after a config change is the surface's responsibility (HTTP route
calls `runtime.mcp_manager.bind_project(...)`; the CLI process is short
lived and the running TUI/serve picks up changes on its next bind)."""

from __future__ import annotations

from docket.config.loader import save_config
from docket.config.mcp_presets import MissingPresetEnvError, UnknownPresetError
from docket.config.models import Config, MCPServerEntry, ProjectEntry
from docket.config.paths import Paths


class UnknownProjectError(KeyError):
    """Raised when the caller targets a project id that isn't in the config."""


class UnknownServerError(KeyError):
    """Raised when the caller targets an MCP server name that isn't configured."""


class DuplicateServerError(ValueError):
    """Raised when `add` is called with a name that already exists for the project."""


class InvalidServerConfigError(ValueError):
    """Raised when an MCP server entry uses unsupported or invalid settings."""


def _project(config: Config, project_id: str) -> ProjectEntry:
    entry = config.projects.get(project_id)
    if entry is None:
        raise UnknownProjectError(project_id)
    return entry


SUPPORTED_TRANSPORTS = frozenset({"stdio", "http", "sse"})


def validate_entry(entry: MCPServerEntry) -> MCPServerEntry:
    """Normalize and validate one server entry.

    Per-transport requirements:
      stdio    requires `command`; ignores `url`/`headers`.
      http/sse requires `url`;     ignores `command`/`args`/`env`.

    Centralized so CLI, TUI, HTTP, and runtime rebinding all enforce the
    same contract."""
    transport = (entry.transport or "stdio").strip() or "stdio"
    if transport not in SUPPORTED_TRANSPORTS:
        raise InvalidServerConfigError(
            f"Unsupported MCP transport '{transport}'. "
            f"Supported: {', '.join(sorted(SUPPORTED_TRANSPORTS))}."
        )
    timeout = float(entry.startup_timeout_seconds)
    if timeout <= 0:
        raise InvalidServerConfigError("startup_timeout_seconds must be > 0.")
    if transport == "stdio":
        if not entry.command.strip():
            raise InvalidServerConfigError("stdio transport requires a `command`.")
        return MCPServerEntry(
            transport=transport,
            command=entry.command,
            args=list(entry.args),
            env=dict(entry.env),
            enabled=entry.enabled,
            startup_timeout_seconds=timeout,
        )
    # http / sse — drop the stdio-only fields so on-disk config stays clean.
    if not entry.url.strip():
        raise InvalidServerConfigError(f"{transport} transport requires a `url`.")
    return MCPServerEntry(
        transport=transport,
        url=entry.url,
        headers=dict(entry.headers),
        enabled=entry.enabled,
        startup_timeout_seconds=timeout,
    )


def list_servers(config: Config, project_id: str) -> dict[str, MCPServerEntry]:
    """Snapshot of the project's configured MCP servers (sorted by name)."""
    project = _project(config, project_id)
    return dict(sorted(project.mcp.items()))


def get_server(config: Config, project_id: str, name: str) -> MCPServerEntry:
    project = _project(config, project_id)
    entry = project.mcp.get(name)
    if entry is None:
        raise UnknownServerError(name)
    return entry


def add_server(
    config: Config,
    paths: Paths,
    project_id: str,
    name: str,
    *,
    command: str = "",
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    url: str = "",
    headers: dict[str, str] | None = None,
    transport: str = "stdio",
    enabled: bool = True,
    startup_timeout_seconds: float = 10.0,
) -> MCPServerEntry:
    """Add a new server to the project. Persists to `config.toml`."""
    project = _project(config, project_id)
    if name in project.mcp:
        raise DuplicateServerError(name)
    entry = validate_entry(
        MCPServerEntry(
            transport=transport,
            command=command,
            args=list(args or []),
            env=dict(env or {}),
            url=url,
            headers=dict(headers or {}),
            enabled=enabled,
            startup_timeout_seconds=startup_timeout_seconds,
        )
    )
    project.mcp[name] = entry
    save_config(paths, config)
    return entry


def update_server(
    config: Config,
    paths: Paths,
    project_id: str,
    name: str,
    *,
    command: str | None = None,
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
    url: str | None = None,
    headers: dict[str, str] | None = None,
    transport: str | None = None,
    enabled: bool | None = None,
    startup_timeout_seconds: float | None = None,
) -> MCPServerEntry:
    """Replace fields on an existing server entry. Only the kwargs you set
    are written; pass `args=[]`, `env={}`, or `headers={}` to explicitly
    clear those collections.
    """
    existing = get_server(config, project_id, name)
    entry = validate_entry(
        MCPServerEntry(
            transport=transport if transport is not None else existing.transport,
            command=command if command is not None else existing.command,
            args=list(args) if args is not None else list(existing.args),
            env=dict(env) if env is not None else dict(existing.env),
            url=url if url is not None else existing.url,
            headers=dict(headers) if headers is not None else dict(existing.headers),
            enabled=enabled if enabled is not None else existing.enabled,
            startup_timeout_seconds=(
                startup_timeout_seconds
                if startup_timeout_seconds is not None
                else existing.startup_timeout_seconds
            ),
        )
    )
    config.projects[project_id].mcp[name] = entry
    save_config(paths, config)
    return entry


def remove_server(config: Config, paths: Paths, project_id: str, name: str) -> None:
    """Delete a server entry from the project."""
    project = _project(config, project_id)
    if name not in project.mcp:
        raise UnknownServerError(name)
    del project.mcp[name]
    save_config(paths, config)


__all__ = [
    "SUPPORTED_TRANSPORTS",
    "DuplicateServerError",
    "InvalidServerConfigError",
    "MissingPresetEnvError",
    "UnknownPresetError",
    "UnknownProjectError",
    "UnknownServerError",
    "add_server",
    "get_server",
    "list_servers",
    "remove_server",
    "update_server",
    "validate_entry",
]
