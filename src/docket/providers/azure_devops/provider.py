"""Azure DevOps provider.

Implements the full `WorkItemProvider` contract: list/get/comments, transitions,
description patches, attachment uploads, and item creation. All writes go
through the mutation service; the provider itself is a thin adapter around the
Azure DevOps SDK.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any

from azure.devops.connection import Connection  # type: ignore[import-untyped]
from azure.devops.v7_0.work_item_tracking.models import TeamContext  # type: ignore[import-untyped]
from msrest.authentication import BasicAuthentication

from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ScopeFilters,
    TransitionIntent,
)
from docket.providers.azure_devops.auth import get_azure_devops_bearer_token
from docket.providers.azure_devops.field_map import html_to_md, to_item
from docket.providers.azure_devops.state_map import KIND_BY_WIT, merge_tags, plan_for_intent
from docket.providers.base import ProviderUnreachableError

_MAX_WIQL_IDS = 200  # Azure DevOps caps at 20,000 per query; we batch defensively

_DEFAULT_FIELDS: tuple[str, ...] = (
    "System.Id",
    "System.WorkItemType",
    "System.Title",
    "System.Description",
    "System.State",
    "System.AssignedTo",
    "System.Parent",
    "System.Tags",
    "System.ChangedDate",
    "System.AreaPath",
    "System.IterationPath",
    "System.TeamProject",
)


class AzureDevOpsProvider:
    """Implements WorkItemProvider against Azure DevOps Boards."""

    def __init__(
        self,
        organization_url: str,
        project: str,
        *,
        display_name: str = "Azure DevOps",
    ) -> None:
        self._org = organization_url.rstrip("/")
        self._project = project
        self._connection: Connection | None = None
        self.display_name = display_name

    # -- infra ---------------------------------------------------------------

    def _conn(self) -> Connection:
        if self._connection is None:
            token = get_azure_devops_bearer_token()
            self._connection = Connection(
                base_url=self._org,
                creds=BasicAuthentication("", token),
            )
        return self._connection

    def _wit_client(self) -> Any:
        return self._conn().clients.get_work_item_tracking_client()

    # -- health --------------------------------------------------------------

    def health_check(self) -> None:
        try:
            core = self._conn().clients.get_core_client()
            core.get_project(self._project)
        except Exception as e:  # azure-devops raises its own exception types
            raise ProviderUnreachableError(
                f"Azure DevOps unreachable or project not found: {e}"
            ) from e

    def current_user_identity(self) -> str | None:
        """Azure DevOps stamps `Item.assignee` with the `uniqueName` of the
        assigned identity (typically the user's email). Fetch it from the
        Profile API so the `@me` visual filter can match cached rows.
        Returns None on any error — `@me` then degrades to no filter."""
        try:
            profile_client = self._conn().clients.get_profile_client()
        except Exception:
            return None
        try:
            profile = profile_client.get_profile(id="me")
        except Exception:
            return None
        # `emailAddress` on the profile matches the `uniqueName` stamped on
        # assignees in practice; fall back to the profile display name.
        email = getattr(profile, "email_address", None)
        if isinstance(email, str) and email:
            return email
        display = getattr(profile, "display_name", None)
        return display if isinstance(display, str) and display else None

    # -- reads ---------------------------------------------------------------

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        wiql = self._build_wiql(watermark, filters)
        wit = self._wit_client()
        try:
            result = wit.query_by_wiql(
                {"query": wiql},
                team_context=TeamContext(project=self._project),
            )
        except Exception as e:
            raise ProviderUnreachableError(f"WIQL query failed: {e}") from e

        ids = [ref.id for ref in (result.work_items or [])]
        if not ids:
            return []

        items: list[Item] = []
        for chunk_start in range(0, len(ids), _MAX_WIQL_IDS):
            chunk = ids[chunk_start : chunk_start + _MAX_WIQL_IDS]
            batch = wit.get_work_items(ids=chunk, fields=list(_DEFAULT_FIELDS), error_policy="omit")
            for raw in batch:
                if raw is None:
                    continue
                built = to_item(raw, url=self._web_url(raw.id))
                if built is not None:
                    items.append(built)
        return items

    def get_item(self, id: str) -> Item:
        wit = self._wit_client()
        raw = wit.get_work_item(int(id), expand="All")
        built = to_item(raw, url=self._web_url(raw.id))
        if built is None:
            raise ProviderUnreachableError(f"Work item {id} is not a tracked type")
        return built

    def get_comments(self, id: str) -> list[Comment]:
        wit = self._wit_client()
        resp = wit.get_comments(project=self._project, work_item_id=int(id))
        comments = getattr(resp, "comments", []) or []
        return [
            Comment(
                id=str(c.id),
                item_id=id,
                author=(
                    getattr(c.created_by, "unique_name", None)
                    or getattr(c.created_by, "display_name", None)
                    or "unknown"
                ),
                body_md=html_to_md(c.text),
                created_at=c.created_date,
            )
            for c in comments
        ]

    def get_linked(self, id: str) -> list[Item]:
        wit = self._wit_client()
        raw = wit.get_work_item(int(id), expand="Relations")
        related_ids: list[int] = []
        for rel in getattr(raw, "relations", None) or []:
            url = getattr(rel, "url", "") or ""
            # relation URLs end with /_apis/wit/workItems/<id>
            tail = url.rstrip("/").rsplit("/", 1)[-1]
            if tail.isdigit():
                related_ids.append(int(tail))
        if not related_ids:
            return []
        batch = wit.get_work_items(
            ids=related_ids, fields=list(_DEFAULT_FIELDS), error_policy="omit"
        )
        out: list[Item] = []
        for r in batch:
            if r is None:
                continue
            built = to_item(r, url=self._web_url(r.id))
            if built is not None:
                out.append(built)
        return out

    # -- writes --------------------------------------------------------------

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        current = self.get_item(id)
        plan = plan_for_intent(intent)
        new_tags = merge_tags(current.tags, plan)
        patch: list[dict[str, Any]] = []
        if plan.state is not None:
            patch.append({"op": "add", "path": "/fields/System.State", "value": plan.state})
        patch.append({"op": "add", "path": "/fields/System.Tags", "value": "; ".join(new_tags)})
        wit = self._wit_client()
        raw = wit.update_work_item(document=patch, id=int(id))
        built = to_item(raw, url=self._web_url(raw.id))
        if built is None:
            raise ProviderUnreachableError(
                f"Work item {id} is no longer a tracked type after update"
            )
        return built

    def patch_description(self, id: str, new_md: str) -> Item:
        patch: list[dict[str, Any]] = [
            {"op": "add", "path": "/fields/System.Description", "value": new_md}
        ]
        wit = self._wit_client()
        raw = wit.update_work_item(document=patch, id=int(id))
        built = to_item(raw, url=self._web_url(raw.id))
        if built is None:
            raise ProviderUnreachableError(
                f"Work item {id} is no longer a tracked type after update"
            )
        return built

    def upload_attachment(self, id: str, filename: str, content: bytes, content_type: str) -> str:
        import io

        wit = self._wit_client()
        upload = wit.create_attachment(
            upload_stream=io.BytesIO(content),
            project=self._project,
            file_name=filename,
            upload_type="simple",
        )
        patch: list[dict[str, Any]] = [
            {
                "op": "add",
                "path": "/relations/-",
                "value": {
                    "rel": "AttachedFile",
                    "url": upload.url,
                    "attributes": {"name": filename, "comment": ""},
                },
            }
        ]
        wit.update_work_item(document=patch, id=int(id))
        return str(upload.url)

    def add_comment(self, id: str, body_md: str) -> Comment:
        # Azure DevOps stores comment bodies as HTML. We send the raw markdown
        # text — the API renders user-supplied newlines acceptably for plain
        # text. Callers wanting rich rendering should pre-format to HTML.
        wit = self._wit_client()
        request = {"text": body_md}
        resp = wit.add_comment(request=request, project=self._project, work_item_id=int(id))
        author = (
            getattr(getattr(resp, "created_by", None), "unique_name", None)
            or getattr(getattr(resp, "created_by", None), "display_name", None)
            or "unknown"
        )
        created = getattr(resp, "created_date", None)
        if created is None:
            raise ProviderUnreachableError(f"add_comment returned no created_date for {id}")
        return Comment(
            id=str(getattr(resp, "id", "")),
            item_id=id,
            author=author,
            body_md=html_to_md(getattr(resp, "text", "") or body_md),
            created_at=created,
        )

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        from docket.providers.azure_devops.state_map import WIT_BY_KIND

        wit_type = WIT_BY_KIND.get(kind)
        if wit_type is None:
            raise ValueError(f"unsupported kind for create: {kind!r}")
        patch: list[dict[str, Any]] = [
            {"op": "add", "path": "/fields/System.Title", "value": fields.title},
        ]
        if fields.description_md:
            patch.append(
                {"op": "add", "path": "/fields/System.Description", "value": fields.description_md}
            )
        if fields.assignee:
            patch.append(
                {"op": "add", "path": "/fields/System.AssignedTo", "value": fields.assignee}
            )
        if fields.tags:
            patch.append(
                {"op": "add", "path": "/fields/System.Tags", "value": "; ".join(fields.tags)}
            )
        if fields.parent_id:
            parent_url = f"{self._org}/_apis/wit/workItems/{fields.parent_id}"
            patch.append(
                {
                    "op": "add",
                    "path": "/relations/-",
                    "value": {
                        "rel": "System.LinkTypes.Hierarchy-Reverse",
                        "url": parent_url,
                        "attributes": {},
                    },
                }
            )
        client = self._wit_client()
        raw = client.create_work_item(document=patch, project=self._project, type=wit_type)
        built = to_item(raw, url=self._web_url(raw.id))
        if built is None:
            raise ProviderUnreachableError("Created work item is not a tracked type")
        return built

    # -- helpers -------------------------------------------------------------

    def _web_url(self, work_item_id: int | str) -> str:
        return f"{self._org}/{self._project}/_workitems/edit/{work_item_id}"

    def _build_wiql(self, watermark: datetime | None, filters: ScopeFilters) -> str:
        types = ", ".join(f"'{t}'" for t in KIND_BY_WIT)
        clauses: list[str] = [
            f"[System.TeamProject] = '{_escape(self._project)}'",
            f"[System.WorkItemType] IN ({types})",
        ]
        if watermark is not None:
            iso = watermark.isoformat().replace("+00:00", "Z")
            clauses.append(f"[System.ChangedDate] >= '{iso}'")
        if filters.area_path:
            clauses.append(f"[System.AreaPath] UNDER '{_escape(filters.area_path)}'")
        if filters.iteration_path:
            clauses.append(f"[System.IterationPath] UNDER '{_escape(filters.iteration_path)}'")
        if filters.assignee == "@me":
            clauses.append("[System.AssignedTo] = @Me")
        elif filters.assignee:
            clauses.append(f"[System.AssignedTo] = '{_escape(filters.assignee)}'")
        where = " AND ".join(clauses)
        return f"SELECT [System.Id] FROM WorkItems WHERE {where} ORDER BY [System.ChangedDate] ASC"


def _escape(value: str) -> str:
    """Escape single quotes for WIQL literals. WIQL doesn't support parameters."""
    return value.replace("'", "''")
