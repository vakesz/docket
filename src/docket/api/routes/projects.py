"""Project listing, view, and metadata updates.

A project IS the active provider. Switching scope (view) doesn't change the
project — it just re-filters what's shown. Updates here persist back to
`config.toml` and re-mirror into the SQLite `projects` table that
memory/sources/sub-agents reference."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request, status

from docket.api.agent_rebuild import rebuild_agent
from docket.api.auth import require_bearer
from docket.api.deps import get_config, get_conn, get_paths, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import ProjectDTO, ProjectUpdateRequest
from docket.config.models import Config
from docket.config.paths import Paths
from docket.core.model import project_id_for
from docket.core.services import project_service

router = APIRouter(
    prefix="/projects",
    tags=["projects"],
    dependencies=[Depends(require_bearer)],
)


def _to_dto(
    *,
    project_id: str,
    name: str,
    description: str,
    provider_key: str,
    archived: bool,
    active_id: str,
) -> ProjectDTO:
    return ProjectDTO(
        id=project_id,
        name=name,
        description=description,
        provider_key=provider_key,
        active=(project_id == active_id),
        archived=archived,
    )


@router.get("", response_model=list[ProjectDTO])
def list_projects(
    include_archived: bool = False,
    config: Config = Depends(get_config),
    runtime: RuntimeState = Depends(get_runtime),
) -> list[ProjectDTO]:
    """List projects from `config.toml`. Active project is flagged."""
    active_id = runtime.project_id
    out: list[ProjectDTO] = []
    for project_id, entry in sorted(config.projects.items(), key=lambda kv: kv[1].name.lower()):
        if entry.archived and not include_archived:
            continue
        out.append(
            _to_dto(
                project_id=project_id,
                name=entry.name,
                description=entry.description,
                provider_key=entry.provider_key,
                archived=entry.archived,
                active_id=active_id,
            )
        )
    return out


@router.get("/active", response_model=ProjectDTO)
def active_project(
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectDTO:
    """Return the currently-active project.

    Lazily creates a default entry in `config.toml` the first time a new
    provider is queried, so the UI never sees an empty body for the active
    project."""
    project = project_service.activate(
        config,
        paths,
        conn,
        provider_key=runtime.provider_key,
    )
    entry = config.projects[project.id]
    return _to_dto(
        project_id=project.id,
        name=entry.name,
        description=entry.description,
        provider_key=entry.provider_key,
        archived=entry.archived,
        active_id=runtime.project_id,
    )


@router.get("/{project_id:path}", response_model=ProjectDTO)
def get_project(
    project_id: str,
    config: Config = Depends(get_config),
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectDTO:
    entry = config.projects.get(project_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")
    return _to_dto(
        project_id=project_id,
        name=entry.name,
        description=entry.description,
        provider_key=entry.provider_key,
        archived=entry.archived,
        active_id=runtime.project_id,
    )


@router.patch(
    "/{project_id:path}",
    response_model=ProjectDTO,
    dependencies=[Depends(require_not_read_only)],
)
def update_project(
    project_id: str,
    payload: ProjectUpdateRequest,
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectDTO:
    """Rename / re-describe / archive a project. Persists to `config.toml`."""
    entry = config.projects.get(project_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")
    if payload.name is not None or payload.description is not None:
        project_service.upsert(
            config,
            paths,
            conn,
            provider_key=entry.provider_key,
            name=payload.name,
            description=payload.description,
        )
    if payload.archived is True and not entry.archived:
        project_service.archive(config, paths, conn, project_id)
    elif payload.archived is False and entry.archived:
        project_service.unarchive(config, paths, conn, project_id)
    refreshed = config.projects[project_id]
    return _to_dto(
        project_id=project_id,
        name=refreshed.name,
        description=refreshed.description,
        provider_key=refreshed.provider_key,
        archived=refreshed.archived,
        active_id=runtime.project_id,
    )


# Convenience: switch the active project by id. Equivalent to switching the
# active provider, but exposes a single button to the UI. Scope stays at the
# provider's active scope.
@router.post(
    "/{project_id:path}/activate",
    response_model=ProjectDTO,
    dependencies=[Depends(require_not_read_only)],
)
def activate_project(
    project_id: str,
    request: Request,
    config: Config = Depends(get_config),
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectDTO:
    entry = config.projects.get(project_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")
    if entry.provider_key not in runtime.providers:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Provider '{entry.provider_key}' is not currently loaded.",
        )
    runtime.switch_provider(entry.provider_key)
    # Active project changed → memory/sources tools captured the previous one.
    rebuild_agent(request, runtime)
    return _to_dto(
        project_id=project_id,
        name=entry.name,
        description=entry.description,
        provider_key=entry.provider_key,
        archived=entry.archived,
        active_id=project_id_for(entry.provider_key),
    )


__all__ = ["router"]
