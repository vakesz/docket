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

from docket.api.auth import require_bearer
from docket.api.deps import get_config, get_conn, require_not_read_only
from docket.api.schemas import (
    SourceCreateRequest,
    SourceDTO,
    SourceListDTO,
    SourceUpdateRequest,
)
from docket.config.models import Config
from docket.core.model import Source
from docket.core.services import source_service

router = APIRouter(
    tags=["sources"],
    dependencies=[Depends(require_bearer)],
)


def _to_dto(entry: Source) -> SourceDTO:
    return SourceDTO(
        id=entry.id,
        project_id=entry.project_id,
        title=entry.title,
        body_md=entry.body_md,
        kind=entry.kind,
        uri=entry.uri,
        tags=list(entry.tags),
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


def _require_project(config: Config, project_id: str) -> None:
    if project_id not in config.projects:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")


def _require_entry(conn: sqlite3.Connection, source_id: str) -> Source:
    entry = source_service.get_entry(conn, source_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown source '{source_id}'")
    return entry


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
    _require_project(config, project_id)
    entries = source_service.list_entries(conn, project_id, kind=kind, limit=limit)
    return SourceListDTO(
        project_id=project_id,
        entries=[_to_dto(e) for e in entries],
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
    _require_project(config, project_id)
    entries = source_service.search_entries(conn, project_id, q, kind=kind, limit=limit)
    return SourceListDTO(
        project_id=project_id,
        entries=[_to_dto(e) for e in entries],
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
    _require_project(config, project_id)
    try:
        entry = source_service.add_entry(
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
    return _to_dto(entry)


@router.get("/sources/{source_id}", response_model=SourceDTO)
def get_source(
    source_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> SourceDTO:
    entry = _require_entry(conn, source_id)
    return _to_dto(entry)


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
    _require_entry(conn, source_id)
    if (
        payload.title is None
        and payload.body_md is None
        and payload.kind is None
        and payload.uri is None
        and payload.tags is None
    ):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "At least one of title, body_md, kind, uri, tags must be set.",
        )
    updated = source_service.edit_entry(
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
    return _to_dto(updated)


@router.delete(
    "/sources/{source_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def delete_source(
    source_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> None:
    _require_entry(conn, source_id)
    source_service.remove_entry(conn, source_id)


__all__ = ["router"]
