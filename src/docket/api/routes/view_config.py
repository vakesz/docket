"""Per-project facet visibility + caps for the view bar.

`ProjectViewConfig` lives on `ProjectEntry`; this route exposes it for
the SPA's "Project view" settings tab. PATCH replaces named facets and
leaves the rest untouched. To restore a facet to defaults, omit it from
the patch body."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from docket.api.deps import get_paths, get_runtime, require_not_read_only
from docket.api.runtime import RuntimeState
from docket.api.schemas import ProjectViewConfigDTO, ProjectViewConfigPatch
from docket.config.loader import save_config
from docket.config.models import FacetConfig, ProjectEntry, ProjectViewConfig
from docket.config.paths import Paths
from docket.core.model import project_id_for

router = APIRouter(prefix="/projects/{provider_key}/view-config", tags=["view-config"])


def _ensure_project(runtime: RuntimeState, provider_key: str) -> ProjectEntry:
    pid = project_id_for(provider_key)
    project = runtime.config.projects.get(pid)
    if project is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown project '{provider_key}'",
        )
    return project


@router.get("", response_model=ProjectViewConfigDTO)
def get_view_config(
    provider_key: str,
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectViewConfigDTO:
    project = _ensure_project(runtime, provider_key)
    return ProjectViewConfigDTO.from_core(project.view)


@router.patch(
    "",
    response_model=ProjectViewConfigDTO,
    dependencies=[Depends(require_not_read_only)],
)
def patch_view_config(
    provider_key: str,
    payload: ProjectViewConfigPatch,
    paths: Paths = Depends(get_paths),
    runtime: RuntimeState = Depends(get_runtime),
) -> ProjectViewConfigDTO:
    project = _ensure_project(runtime, provider_key)
    facets = dict(project.view.facets)
    for key, dto in payload.facets.items():
        facets[key] = FacetConfig(visible=dto.visible, max_options=dto.max_options)
    project.view = ProjectViewConfig(facets=facets)
    save_config(paths, runtime.config)
    return ProjectViewConfigDTO.from_core(project.view)


__all__ = ["router"]
