"""Per-project source CRUD + search.

Sources are reference documents (requirements, design notes, runbooks) that
the agent can read but not modify. Writes (POST/PATCH/DELETE) come only
from human users; there is no proposal/confirm path because the agent has
no `propose_source_*` tool.

Project ids are composite (e.g. `azure_devops::default`), so the `:path`
converter is required so `/` and other punctuation in scope keys don't
break routing. This router must be registered BEFORE the projects router
in `api/app.py` because `:path` matches greedily across slashes."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.deps import (
    get_config,
    get_conn,
    require_by_id,
    require_not_read_only,
    require_patch_not_empty,
    require_project,
)
from docket.api.schemas import (
    SourceCreateRequest,
    SourceDTO,
    SourceListDTO,
    SourceUpdateRequest,
)
from docket.config.models import Config
from docket.storage.repos import source_repo

router = APIRouter(tags=["sources"])


@router.get(
    "/projects/{project_id:path}/sources",
    response_model=SourceListDTO,
)
def list_sources(
    project_id: str,
    kind: str | None = Query(None, description="Filter by kind."),
    limit: int = Query(100, ge=1, le=500),
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceListDTO:
    require_project(config, project_id)
    entries = source_repo.list_for_project(conn, project_id, kind=kind, limit=limit)
    return SourceListDTO(
        project_id=project_id,
        entries=[SourceDTO.from_core(e) for e in entries],
    )


@router.get(
    "/projects/{project_id:path}/sources/search",
    response_model=SourceListDTO,
)
def search_sources(
    project_id: str,
    q: str = Query(..., min_length=1, description="FTS query."),
    kind: str | None = Query(None, description="Filter by kind."),
    limit: int = Query(20, ge=1, le=100),
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceListDTO:
    require_project(config, project_id)
    entries = source_repo.search(conn, project_id, q, kind=kind, limit=limit)
    return SourceListDTO(
        project_id=project_id,
        entries=[SourceDTO.from_core(e) for e in entries],
    )


@router.post(
    "/projects/{project_id:path}/sources",
    response_model=SourceDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def create_source(
    project_id: str,
    payload: SourceCreateRequest,
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceDTO:
    require_project(config, project_id)
    try:
        entry = source_repo.create(
            conn,
            project_id=project_id,
            title=payload.title,
            body_md=payload.body_md,
            kind=payload.kind,
            uri=payload.uri,
            tags=list(payload.tags),
        )
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    return SourceDTO.from_core(entry)


@router.get("/sources/{source_id}", response_model=SourceDTO)
def get_source(
    source_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceDTO:
    entry = require_by_id(source_repo.get, conn, source_id, label="source")
    return SourceDTO.from_core(entry)


@router.patch(
    "/sources/{source_id}",
    response_model=SourceDTO,
    dependencies=[Depends(require_not_read_only)],
)
def update_source(
    source_id: str,
    payload: SourceUpdateRequest,
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceDTO:
    require_by_id(source_repo.get, conn, source_id, label="source")
    require_patch_not_empty(payload, label="source")
    updated = source_repo.update(
        conn,
        source_id,
        title=payload.title,
        body_md=payload.body_md,
        kind=payload.kind,
        uri=payload.uri,
        tags=list(payload.tags) if payload.tags is not None else None,
    )
    if updated is None:
        # Lost a race with another writer — surface as 404 so the frontend
        # refetches and reconciles.
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Source '{source_id}' vanished")
    return SourceDTO.from_core(updated)


@router.delete(
    "/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def delete_source(
    source_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> None:
    require_by_id(source_repo.get, conn, source_id, label="source")
    source_repo.delete(conn, source_id)


__all__ = ["router"]
