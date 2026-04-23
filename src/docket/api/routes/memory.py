"""Per-project memory CRUD + search.

Direct user writes (POST/PATCH/DELETE) bypass the proposal flow because the
human is already in the loop — they made the request. Agent-initiated writes
flow through the proposal/confirm path under `/proposals/...` instead.

Project ids are composite (e.g. `azure_devops::default`), so the `:path`
converter is required so `/` and other punctuation in scope keys don't break
routing."""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Query, status

from docket.api.auth import require_bearer
from docket.api.deps import get_config, get_conn, require_not_read_only
from docket.api.schemas import (
    MemoryCreateRequest,
    MemoryDTO,
    MemoryListDTO,
    MemoryUpdateRequest,
)
from docket.config.models import Config
from docket.core.model import MemoryEntry
from docket.storage.repos import memory_repo

router = APIRouter(
    tags=["memory"],
    dependencies=[Depends(require_bearer)],
)


def _to_dto(entry: MemoryEntry) -> MemoryDTO:
    return MemoryDTO(
        id=entry.id,
        project_id=entry.project_id,
        title=entry.title,
        body_md=entry.body_md,
        tags=list(entry.tags),
        source=entry.source,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


def _require_project(config: Config, project_id: str) -> None:
    if project_id not in config.projects:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown project '{project_id}'")


def _require_entry(conn: sqlite3.Connection, memory_id: str) -> MemoryEntry:
    entry = memory_repo.get(conn, memory_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown memory entry '{memory_id}'")
    return entry


@router.get(
    "/projects/{project_id:path}/memory",
    response_model=MemoryListDTO,
)
def list_memory(
    project_id: str,
    limit: int = Query(100, ge=1, le=500),
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> MemoryListDTO:
    _require_project(config, project_id)
    entries = memory_repo.list_for_project(conn, project_id, limit=limit)
    revision = memory_repo.get_revision(conn, project_id)
    return MemoryListDTO(
        project_id=project_id,
        revision=revision,
        entries=[_to_dto(e) for e in entries],
    )


@router.get(
    "/projects/{project_id:path}/memory/search",
    response_model=MemoryListDTO,
)
def search_memory(
    project_id: str,
    q: str = Query(..., min_length=1, description="FTS query."),
    limit: int = Query(20, ge=1, le=100),
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> MemoryListDTO:
    _require_project(config, project_id)
    entries = memory_repo.search(conn, project_id, q, limit=limit)
    revision = memory_repo.get_revision(conn, project_id)
    return MemoryListDTO(
        project_id=project_id,
        revision=revision,
        entries=[_to_dto(e) for e in entries],
    )


@router.post(
    "/projects/{project_id:path}/memory",
    response_model=MemoryDTO,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_not_read_only)],
)
def create_memory(
    project_id: str,
    payload: MemoryCreateRequest,
    config: Config = Depends(get_config),
    conn: sqlite3.Connection = Depends(get_conn),
) -> MemoryDTO:
    _require_project(config, project_id)
    try:
        entry = memory_repo.create(
            conn,
            project_id=project_id,
            title=payload.title,
            body_md=payload.body_md,
            tags=list(payload.tags),
            source="user",
        )
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    return _to_dto(entry)


@router.get("/memory/{memory_id}", response_model=MemoryDTO)
def get_memory(
    memory_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> MemoryDTO:
    entry = _require_entry(conn, memory_id)
    return _to_dto(entry)


@router.patch(
    "/memory/{memory_id}",
    response_model=MemoryDTO,
    dependencies=[Depends(require_not_read_only)],
)
def update_memory(
    memory_id: str,
    payload: MemoryUpdateRequest,
    conn: sqlite3.Connection = Depends(get_conn),
) -> MemoryDTO:
    _require_entry(conn, memory_id)
    if payload.title is None and payload.body_md is None and payload.tags is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "At least one of title, body_md, tags must be set.",
        )
    updated = memory_repo.update(
        conn,
        memory_id,
        title=payload.title,
        body_md=payload.body_md,
        tags=list(payload.tags) if payload.tags is not None else None,
    )
    if updated is None:
        # Lost a race with another writer — surface as 404 so the frontend
        # refetches and reconciles.
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Memory entry '{memory_id}' vanished")
    return _to_dto(updated)


@router.delete(
    "/memory/{memory_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_not_read_only)],
)
def delete_memory(
    memory_id: str,
    conn: sqlite3.Connection = Depends(get_conn),
) -> None:
    _require_entry(conn, memory_id)
    memory_repo.delete(conn, memory_id)


__all__ = ["router"]
