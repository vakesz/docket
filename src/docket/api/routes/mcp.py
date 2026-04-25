"""Per-project MCP server CRUD + handshake test.

Persists to `config.toml` via `mcp_service`. When the targeted project is
the runtime's currently-active one, the live `MCPManager` is rebound so
the running agent picks up the new fleet without a server restart. The
agent's tool registry is rebuilt at the same time so the next chat turn
sees the refreshed `mcp__<server>__<tool>` set.

Project ids are composite (e.g. `azure_devops::default`), so the `:path`
converter is required so `/` and other punctuation in scope keys don't
break routing. This router must be registered BEFORE the projects router
in `api/app.py` because `:path` matches greedily across slashes."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status

from docket.agent.mcp import MCPClient
from docket.api.deps import (
    get_config,
    get_paths,
    get_runtime,
    require_not_read_only,
    require_project,
)
from docket.api.runtime import RuntimeState, rebuild_agent
from docket.api.schemas import (
    MCPPresetApplyRequest,
    MCPPresetDTO,
    MCPPresetEnvDTO,
    MCPPresetListDTO,
    MCPServerDTO,
    MCPServerListDTO,
    MCPServerTestResultDTO,
    MCPServerUpdateRequest,
    MCPToolDTO,
)
from docket.config.mcp_presets import MCPPreset, list_presets
from docket.config.models import Config, MCPServerEntry
from docket.config.paths import Paths
from docket.core.services import mcp_service

router = APIRouter(tags=["mcp"])


def _to_dto(project_id: str, name: str, entry: MCPServerEntry) -> MCPServerDTO:
    return MCPServerDTO(
        project_id=project_id,
        name=name,
        transport=entry.transport,
        command=entry.command,
        args=list(entry.args),
        env=dict(entry.env),
        enabled=entry.enabled,
        startup_timeout_seconds=entry.startup_timeout_seconds,
    )


def _refresh_runtime(runtime: RuntimeState, project_id: str, request: Request) -> None:
    """If the changed project is the active one, rebind the live MCP fleet
    and rebuild the agent so the next turn sees the new tool set."""
    if runtime.mcp_manager is None:
        return
    if runtime.project_id != project_id:
        return
    project = runtime.config.projects.get(project_id)
    servers = dict(project.mcp) if project is not None else {}
    runtime.mcp_manager.bind_project(project_id, servers)
    rebuild_agent(request.app, runtime)


def _tool_dto(server_name: str, tool: Any) -> MCPToolDTO:
    return MCPToolDTO(
        id=f"mcp__{server_name}__{tool.name}",
        server_name=server_name,
        name=tool.name,
        description=tool.description or "",
        input_schema=dict(tool.inputSchema) if tool.inputSchema else {},
    )


def _test_result(name: str, entry: MCPServerEntry) -> MCPServerTestResultDTO:
    try:
        entry = mcp_service.validate_entry(entry)
    except mcp_service.InvalidServerConfigError as exc:
        return MCPServerTestResultDTO(name=name, ok=False, error=str(exc))
    if not entry.command:
        return MCPServerTestResultDTO(
            name=name, ok=False, error="Server entry has no `command` configured."
        )
    client = MCPClient(name, entry)
    try:
        client.start()
    except Exception as exc:
        client.close()
        return MCPServerTestResultDTO(name=name, ok=False, error=str(exc))
    try:
        tool_details = sorted(
            (_tool_dto(name, tool) for tool in client.list_tools()),
            key=lambda tool: tool.name,
        )
    finally:
        client.close()
    return MCPServerTestResultDTO(
        name=name,
        ok=True,
        tools=[tool.id for tool in tool_details],
        tool_details=tool_details,
    )


@router.get(
    "/projects/{project_id:path}/mcp",
    response_model=MCPServerListDTO,
)
def list_mcp_servers(
    project_id: str,
    config: Config = Depends(get_config),
) -> MCPServerListDTO:
    require_project(config, project_id)
    servers = mcp_service.list_servers(config, project_id)
    return MCPServerListDTO(
        project_id=project_id,
        entries=[_to_dto(project_id, name, entry) for name, entry in servers.items()],
    )


@router.get(
    "/projects/{project_id:path}/mcp/{name}",
    response_model=MCPServerDTO,
)
def get_mcp_server(
    project_id: str,
    name: str,
    config: Config = Depends(get_config),
) -> MCPServerDTO:
    require_project(config, project_id)
    try:
        entry = mcp_service.get_server(config, project_id, name)
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
    return _to_dto(project_id, name, entry)


@router.post(
    "/projects/{project_id:path}/mcp/{name}",
    response_model=MCPServerDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def create_mcp_server(
    project_id: str,
    name: str,
    payload: MCPServerEntry,
    request: Request,
    config: Config = Depends(get_config),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> MCPServerDTO:
    require_project(config, project_id)
    try:
        entry = mcp_service.add_server(
            config,
            paths,
            project_id,
            name,
            command=payload.command,
            args=list(payload.args),
            env=dict(payload.env),
            transport=payload.transport,
            enabled=payload.enabled,
            startup_timeout_seconds=payload.startup_timeout_seconds,
        )
    except mcp_service.DuplicateServerError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"MCP server '{name}' already exists for project '{project_id}'.",
        ) from exc
    except mcp_service.InvalidServerConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    _refresh_runtime(runtime, project_id, request)
    return _to_dto(project_id, name, entry)


@router.patch(
    "/projects/{project_id:path}/mcp/{name}",
    response_model=MCPServerDTO,
    dependencies=[Depends(require_not_read_only)],
)
def update_mcp_server(
    project_id: str,
    name: str,
    payload: MCPServerUpdateRequest,
    request: Request,
    config: Config = Depends(get_config),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> MCPServerDTO:
    require_project(config, project_id)
    if (
        payload.command is None
        and payload.args is None
        and payload.env is None
        and payload.transport is None
        and payload.enabled is None
        and payload.startup_timeout_seconds is None
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "At least one of command, args, env, transport, enabled, "
            "startup_timeout_seconds must be set.",
        )
    try:
        entry = mcp_service.update_server(
            config,
            paths,
            project_id,
            name,
            command=payload.command,
            args=list(payload.args) if payload.args is not None else None,
            env=dict(payload.env) if payload.env is not None else None,
            transport=payload.transport,
            enabled=payload.enabled,
            startup_timeout_seconds=payload.startup_timeout_seconds,
        )
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
    except mcp_service.InvalidServerConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    _refresh_runtime(runtime, project_id, request)
    return _to_dto(project_id, name, entry)


@router.delete(
    "/projects/{project_id:path}/mcp/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def delete_mcp_server(
    project_id: str,
    name: str,
    request: Request,
    config: Config = Depends(get_config),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> None:
    require_project(config, project_id)
    try:
        mcp_service.remove_server(config, paths, project_id, name)
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
    _refresh_runtime(runtime, project_id, request)


@router.post(
    "/projects/{project_id:path}/mcp/{name}/test",
    response_model=MCPServerTestResultDTO,
    dependencies=[Depends(require_not_read_only)],
)
def test_mcp_server(
    project_id: str,
    name: str,
    payload: MCPServerEntry | None = Body(None),
    config: Config = Depends(get_config),
) -> MCPServerTestResultDTO:
    """Spawn an MCP server, complete the handshake, list its tools, then close.

    With a body, validates a draft entry without persisting it (used by the
    Settings UI before save). Without a body, looks up the saved entry and
    spawns a fresh subprocess for it — the live runtime fleet is not touched
    either way."""
    require_project(config, project_id)
    if payload is not None:
        return _test_result(name, payload)
    try:
        entry = mcp_service.get_server(config, project_id, name)
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
    return _test_result(name, entry)


def _preset_dto(preset: MCPPreset) -> MCPPresetDTO:
    return MCPPresetDTO(
        id=preset.id,
        label=preset.label,
        description=preset.description,
        default_name=preset.default_name,
        command=preset.command,
        args=list(preset.args),
        env=[
            MCPPresetEnvDTO(
                name=var.name,
                description=var.description,
                placeholder=var.placeholder,
            )
            for var in preset.env
        ],
        docs_url=preset.docs_url,
        startup_timeout_seconds=preset.startup_timeout_seconds,
    )


@router.get(
    "/mcp/presets",
    response_model=MCPPresetListDTO,
)
def list_mcp_presets() -> MCPPresetListDTO:
    """Return the catalog of known-good MCP server presets.

    Read-only and project-independent — both bootstrap and full servers can
    serve this so the setup UI can show presets before any project exists."""
    return MCPPresetListDTO(presets=[_preset_dto(p) for p in list_presets()])


@router.post(
    "/projects/{project_id:path}/mcp/presets/{preset_id}/apply",
    response_model=MCPServerDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def apply_mcp_preset(
    project_id: str,
    preset_id: str,
    payload: MCPPresetApplyRequest,
    request: Request,
    config: Config = Depends(get_config),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> MCPServerDTO:
    """Instantiate a preset as a concrete MCP server on this project.

    The preset supplies `command`/`args`/`transport`; the caller supplies env
    values (typically an API token) via `payload.env`. Returns 400 if the
    preset or a required env var is missing, 409 on name conflict."""
    from docket.config.mcp_presets import apply_preset, get_preset

    require_project(config, project_id)
    try:
        preset = get_preset(preset_id)
        entry = apply_preset(preset_id, env=dict(payload.env))
        server_name = (payload.name or preset.default_name).strip() or preset.default_name
        entry = mcp_service.add_server(
            config,
            paths,
            project_id,
            server_name,
            command=entry.command,
            args=list(entry.args),
            env=dict(entry.env),
            transport=entry.transport,
            enabled=payload.enabled,
            startup_timeout_seconds=entry.startup_timeout_seconds,
        )
    except mcp_service.UnknownPresetError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP preset '{preset_id}'") from exc
    except mcp_service.MissingPresetEnvError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except mcp_service.DuplicateServerError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"MCP server '{payload.name or preset_id}' already exists on '{project_id}'.",
        ) from exc
    except mcp_service.InvalidServerConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    _refresh_runtime(runtime, project_id, request)
    return _to_dto(project_id, server_name, entry)


__all__ = ["router"]
