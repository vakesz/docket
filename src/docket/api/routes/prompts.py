"""Prompt library CRUD — list/read/edit/reset the agent's system + per-kind
prompts.

Writes go to `$XDG_CONFIG_HOME/docket/prompts/<filename>`. The existing
mtime-keyed loader cache in `agent/prompt.py` picks up edits on the next
chat turn without a restart — nothing for this module to do there."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status

from docket.agent.prompt import (
    PromptTemplate,
    get_template,
    list_templates,
    read_prompt,
    write_prompt,
)
from docket.agent.prompt import (
    reset_prompt as reset_prompt_file,
)
from docket.api.deps import get_paths, require_not_read_only
from docket.api.schemas import PromptDTO, PromptSummaryDTO, PromptUpdateRequest
from docket.config.paths import Paths

router = APIRouter(prefix="/prompts", tags=["prompts"])


def _is_customized(paths: Paths, template: PromptTemplate) -> bool:
    return (paths.prompts_dir / template.filename).exists()


@router.get("", response_model=list[PromptSummaryDTO])
def list_prompts(paths: Paths = Depends(get_paths)) -> list[PromptSummaryDTO]:
    return [
        PromptSummaryDTO(
            key=t.key,
            label=t.label,
            filename=t.filename,
            customized=_is_customized(paths, t),
        )
        for t in list_templates()
    ]


@router.get("/{key}", response_model=PromptDTO)
def get_prompt(key: str, paths: Paths = Depends(get_paths)) -> PromptDTO:
    try:
        template = get_template(key)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown prompt '{key}'") from e
    content = read_prompt(paths.prompts_dir, key)
    return PromptDTO(
        key=template.key,
        label=template.label,
        filename=template.filename,
        content_md=content,
        customized=_is_customized(paths, template),
    )


@router.put(
    "/{key}",
    response_model=PromptDTO,
    dependencies=[Depends(require_not_read_only)],
)
def put_prompt(
    key: str,
    payload: PromptUpdateRequest,
    paths: Paths = Depends(get_paths),
) -> PromptDTO:
    try:
        template = get_template(key)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown prompt '{key}'") from e
    write_prompt(paths.prompts_dir, key, payload.content_md)
    return PromptDTO(
        key=template.key,
        label=template.label,
        filename=template.filename,
        content_md=payload.content_md,
        customized=True,
    )


@router.delete(
    "/{key}",
    response_model=PromptDTO,
    dependencies=[Depends(require_not_read_only)],
)
def reset_prompt(
    key: str,
    paths: Paths = Depends(get_paths),
) -> PromptDTO:
    """Restore the canonical template.

    The customized flag stays `True` because reset rewrites the file to the
    default rather than deleting it. Clients can distinguish by reading the
    content — the returned `content_md` is exactly the canonical template."""
    try:
        template = get_template(key)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Unknown prompt '{key}'") from e
    reset_prompt_file(paths.prompts_dir, key)
    return PromptDTO(
        key=template.key,
        label=template.label,
        filename=template.filename,
        content_md=template.default_text,
        customized=True,
    )


__all__ = ["router"]
