from __future__ import annotations

from datetime import UTC, datetime

from docket.core.model import Item, ItemKind, ItemState, TransitionIntent
from docket.core.mutation import DescriptionPatch, StateChange
from docket.core.services.proposal_store import ProposalStore


def _item() -> Item:
    return Item(
        id="S-1",
        kind=ItemKind.STORY,
        title="Login",
        description_md="x",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


def test_add_get_pop_roundtrip() -> None:
    store = ProposalStore()
    p = StateChange(item=_item(), intent=TransitionIntent.START_WORK)
    returned_id = store.add(p)
    assert returned_id == p.id
    assert len(store) == 1
    fetched = store.get(p.id)
    assert fetched is not None
    assert fetched.proposal is p
    assert fetched.source == "agent"
    popped = store.pop(p.id)
    assert popped is not None and popped.proposal.id == p.id
    assert store.get(p.id) is None
    assert len(store) == 0


def test_peek_next_preserves_fifo_without_removing() -> None:
    store = ProposalStore()
    p1 = StateChange(item=_item(), intent=TransitionIntent.START_WORK)
    p2 = DescriptionPatch(item=_item(), new_md="new")
    store.add(p1)
    store.add(p2)
    first = store.peek_next()
    assert first is not None and first.proposal.id == p1.id
    # peek again — still the same head
    again = store.peek_next()
    assert again is not None and again.proposal.id == p1.id
    assert len(store) == 2
    # drain
    store.pop(p1.id)
    head = store.peek_next()
    assert head is not None and head.proposal.id == p2.id


def test_source_labelling_flows_through() -> None:
    store = ProposalStore()
    p = DescriptionPatch(item=_item(), new_md="new")
    store.add(p, source="cli")
    pending = store.peek_next()
    assert pending is not None
    assert pending.source == "cli"


def test_pop_missing_returns_none() -> None:
    store = ProposalStore()
    assert store.pop("no-such-id") is None


def test_clear_removes_all() -> None:
    store = ProposalStore()
    store.add(StateChange(item=_item(), intent=TransitionIntent.START_WORK))
    store.add(DescriptionPatch(item=_item(), new_md="x"))
    assert len(store) == 2
    store.clear()
    assert len(store) == 0
    assert store.peek_next() is None


def test_list_returns_insertion_order() -> None:
    store = ProposalStore()
    p1 = StateChange(item=_item(), intent=TransitionIntent.START_WORK)
    p2 = DescriptionPatch(item=_item(), new_md="a")
    store.add(p1)
    store.add(p2)
    ids = [pending.proposal.id for pending in store.list()]
    assert ids == [p1.id, p2.id]
