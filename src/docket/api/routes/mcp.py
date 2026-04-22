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

from fastapi import APIRouter, Depends, HTTPException, Request, status

from docket.agent.mcp import MCPClient
from docket.api.agent_rebuild import rebuild_agent
from docket.api.auth import require_bearer
from docket.api.deps import get_config, get_paths, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import (
    MCPServerCreateRequest,
    MCPServerDTO,
    MCPServerListDTO,
    MCPServerTestResultDTO,
    MCPServerUpdateRequest,
)
from docket.config.models import Config, MCPServerEntry
from docket.config.paths import Paths
from docket.core.services import mcp_service

router = APIRouter(
    tags=["mcp"],
    dependencies=[Depends(require_bearer)],
)


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


def _require_project(config: Config, project_id: str) -> None:
    if project_id not in config.projects:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")


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
    rebuild_agent(request, runtime)


@router.get(
    "/projects/{project_id:path}/mcp",
    response_model=MCPServerListDTO,
)
def list_mcp_servers(
    project_id: str,
    config: Config = Depends(get_config),
) -> MCPServerListDTO:
    _require_project(config, project_id)
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
    _require_project(config, project_id)
    try:
        entry = mcp_service.get_server(config, project_id, name)
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
    return _to_dto(project_id, name, entry)


@router.post(
    "/projects/{project_id:path}/mcp",
    response_model=MCPServerDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def create_mcp_server(
    project_id: str,
    payload: MCPServerCreateRequest,
    request: Request,
    config: Config = Depends(get_config),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> MCPServerDTO:
    _require_project(config, project_id)
    try:
        entry = mcp_service.add_server(
            config,
            paths,
            project_id,
            payload.name,
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
            f"MCP server '{payload.name}' already exists for project '{project_id}'.",
        ) from exc
    _refresh_runtime(runtime, project_id, request)
    return _to_dto(project_id, payload.name, entry)


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
    _require_project(config, project_id)
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
    _require_project(config, project_id)
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
    config: Config = Depends(get_config),
) -> MCPServerTestResultDTO:
    """Spawn the configured MCP server, complete the handshake, list its
    tools, then close. Lets the UI verify a fresh entry without restarting
    the running fleet."""
    _require_project(config, project_id)
    try:
        entry = mcp_service.get_server(config, project_id, name)
    except mcp_service.UnknownServerError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown MCP server '{name}'") from exc
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
        tools = sorted(f"mcp__{name}__{tool.name}" for tool in client.list_tools())
    finally:
        client.close()
    return MCPServerTestResultDTO(name=name, ok=True, tools=tools)


__all__ = ["router"]
