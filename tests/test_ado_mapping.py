from __future__ import annotations

from datetime import datetime

import pytest

from docket.core import ItemKind, ItemState
from docket.providers.azure_devops.field_map import to_item
from docket.providers.azure_devops.state_map import is_removed, map_state


class _FakeWI:
    def __init__(self, id: int, fields: dict) -> None:
        self.id = id
        self.fields = fields


# ---- state_map ---------------------------------------------------------------

@pytest.mark.parametrize(
    "ado_state,expected",
    [
        ("New", ItemState.NEW),
        ("Active", ItemState.ACTIVE),
        ("Resolved", ItemState.RESOLVED),
        ("Closed", ItemState.CLOSED),
        ("Removed", ItemState.CLOSED),
        ("Something", ItemState.ACTIVE),  # fallback
    ],
)
def test_map_state_agile(ado_state: str, expected: ItemState) -> None:
    assert map_state(ItemKind.STORY, ado_state) is expected


def test_is_removed() -> None:
    assert is_removed("Removed")
    assert not is_removed("Closed")


# ---- field_map ---------------------------------------------------------------

def test_to_item_from_attrs_shape() -> None:
    wi = _FakeWI(
        42,
        {
            "System.Id": 42,
            "System.WorkItemType": "User Story",
            "System.Title": "Ship it",
            "System.Description": "<p>body</p>",
            "System.State": "Active",
            "System.AssignedTo": {"uniqueName": "alice@x.com", "displayName": "Alice"},
            "System.Parent": 41,
            "System.Tags": "backend; urgent",
            "System.ChangedDate": "2026-04-21T10:00:00Z",
        },
    )
    item = to_item(wi, url="https://x/42")
    assert item is not None
    assert item.id == "42"
    assert item.kind is ItemKind.STORY
    assert item.state is ItemState.ACTIVE
    assert item.assignee == "alice@x.com"
    assert item.parent_id == "41"
    assert item.tags == ["backend", "urgent"]
    assert item.url == "https://x/42"
    assert isinstance(item.updated_at, datetime)


def test_to_item_from_dict_shape() -> None:
    raw = {"id": 7, "fields": {"System.Id": 7, "System.WorkItemType": "Bug", "System.Title": "t", "System.State": "New"}}
    item = to_item(raw)
    assert item is not None
    assert item.kind is ItemKind.BUG
    assert item.state is ItemState.NEW


def test_to_item_returns_none_for_untracked_wit() -> None:
    wi = _FakeWI(1, {"System.Id": 1, "System.WorkItemType": "Issue", "System.State": "Active"})
    assert to_item(wi) is None


def test_to_item_flags_removed_in_provider_raw() -> None:
    wi = _FakeWI(1, {"System.Id": 1, "System.WorkItemType": "Task", "System.Title": "t", "System.State": "Removed"})
    item = to_item(wi)
    assert item is not None
    assert item.provider_raw.get("archived") is True


def test_to_item_converts_html_description_to_markdown() -> None:
    wi = _FakeWI(
        5,
        {
            "System.Id": 5,
            "System.WorkItemType": "Task",
            "System.Title": "t",
            "System.State": "Active",
            "System.Description": "<div><p>Hello <b>world</b></p><ul><li>a</li><li>b</li></ul></div>",
        },
    )
    item = to_item(wi)
    assert item is not None
    assert "Hello" in item.description_md
    assert "**world**" in item.description_md
    assert "* a" in item.description_md


def test_to_item_passes_through_plain_text_description() -> None:
    wi = _FakeWI(
        6,
        {
            "System.Id": 6,
            "System.WorkItemType": "Task",
            "System.Title": "t",
            "System.State": "Active",
            "System.Description": "already plain markdown",
        },
    )
    item = to_item(wi)
    assert item is not None
    assert item.description_md == "already plain markdown"


class _FakeRelation:
    def __init__(self, rel: str, url: str, attributes: dict) -> None:
        self.rel = rel
        self.url = url
        self.attributes = attributes


class _FakeWIWithRelations(_FakeWI):
    def __init__(self, id: int, fields: dict, relations: list) -> None:
        super().__init__(id, fields)
        self.relations = relations


def test_to_item_parses_attachments_from_relations() -> None:
    wi = _FakeWIWithRelations(
        9,
        {"System.Id": 9, "System.WorkItemType": "Task", "System.Title": "t", "System.State": "Active"},
        relations=[
            _FakeRelation("AttachedFile", "https://ado/att/1", {"name": "crash.log"}),
            _FakeRelation("System.LinkTypes.Hierarchy-Reverse", "https://ado/wit/41", {}),
            _FakeRelation("AttachedFile", "https://ado/att/2", {"name": "screenshot.png"}),
        ],
    )
    item = to_item(wi)
    assert item is not None
    assert [a.filename for a in item.attachments] == ["crash.log", "screenshot.png"]
    assert item.attachments[0].url == "https://ado/att/1"
