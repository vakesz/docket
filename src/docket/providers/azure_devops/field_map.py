"""Convert raw ADO work-item dicts into canonical Item instances and vice versa."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from markdownify import markdownify

from docket.core.model import Attachment, Item, ItemKind
from docket.providers.azure_devops.state_map import KIND_BY_WIT, is_removed, map_state


def ado_fields(work_item: Any) -> dict[str, Any]:
    """ADO SDK returns WorkItem objects whose `.fields` is a dict[str, Any]. When
    we read from WIQL batches via REST the same shape applies. Normalize both here."""
    if hasattr(work_item, "fields") and isinstance(work_item.fields, dict):
        return dict(work_item.fields)
    if isinstance(work_item, dict):
        return dict(work_item.get("fields", work_item))
    raise TypeError(f"unexpected work-item shape: {type(work_item)!r}")


def _parse_ado_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    # ADO returns ISO-8601 with Z suffix; fromisoformat handles Z in 3.11+
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _tags(value: Any) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [t.strip() for t in value if t.strip()]
    # ADO encodes tags as "a; b; c"
    return [t.strip() for t in str(value).split(";") if t.strip()]


def _assignee(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, dict):
        return value.get("uniqueName") or value.get("displayName")
    return str(value)


def html_to_md(value: Any) -> str:
    """ADO stores rich-text fields (Description, Repro Steps) as HTML. Textual's
    Markdown widget silently renders block-level HTML as nothing, which is why
    descriptions appear empty in the detail pane. Convert with markdownify so
    the stored value round-trips through markdown rendering."""
    if not value:
        return ""
    text = str(value)
    if "<" not in text:
        return text
    return markdownify(text, heading_style="ATX").strip()


def _attachments(relations: Any) -> list[Attachment]:
    """Parse the `relations` array returned when we fetch with expand=Relations
    or expand=All. ADO models attachments as a relation of type `AttachedFile`
    whose `url` is a downloadable endpoint and whose attributes carry the name."""
    out: list[Attachment] = []
    for rel in relations or []:
        rel_type = getattr(rel, "rel", None) or (rel.get("rel") if isinstance(rel, dict) else None)
        if rel_type != "AttachedFile":
            continue
        url = getattr(rel, "url", None) or (rel.get("url") if isinstance(rel, dict) else None)
        attrs = getattr(rel, "attributes", None) or (rel.get("attributes") if isinstance(rel, dict) else None) or {}
        name = attrs.get("name") if isinstance(attrs, dict) else getattr(attrs, "name", None)
        out.append(Attachment(filename=name or "attachment", url=url))
    return out


def to_item(work_item: Any, *, url: str | None = None) -> Item | None:
    """Build a canonical Item. Returns None for work-item types we don't track
    (e.g. Test Cases, Issues) so sync can skip them without failing."""
    fields = ado_fields(work_item)
    wit = fields.get("System.WorkItemType", "")
    kind = KIND_BY_WIT.get(wit)
    if kind is None:
        return None

    ado_state = fields.get("System.State", "")
    state = map_state(kind, ado_state)
    item_id = str(getattr(work_item, "id", None) or fields.get("System.Id") or "")
    if not item_id:
        return None

    parent_id: str | None = None
    # System.Parent is present when expanded; relations carry it otherwise (handled in provider).
    if fields.get("System.Parent"):
        parent_id = str(fields["System.Parent"])

    item = Item(
        id=item_id,
        kind=kind,
        title=fields.get("System.Title", "") or "",
        description_md=html_to_md(fields.get("System.Description")),
        state=state,
        assignee=_assignee(fields.get("System.AssignedTo")),
        parent_id=parent_id,
        tags=_tags(fields.get("System.Tags")),
        updated_at=_parse_ado_datetime(fields.get("System.ChangedDate")),
        url=url,
        attachments=_attachments(getattr(work_item, "relations", None)),
        provider_raw={"fields": fields, "wit": wit, "ado_state": ado_state},
    )
    # Mark as archived via a provider_raw flag the sync service can read. We don't
    # touch Item.archived here because that lives on the storage layer.
    if is_removed(ado_state):
        item.provider_raw["archived"] = True
    return item


def kind_from_item(item: Item) -> ItemKind:
    return item.kind
