from __future__ import annotations

import pytest

from docket.core.model import ItemKind, TransitionIntent
from docket.providers.azure_devops.state_map import merge_tags, plan_for_intent


def test_start_work_clears_soft_tags() -> None:
    plan = plan_for_intent(ItemKind.STORY, TransitionIntent.START_WORK)
    assert plan.ado_state == "Active"
    merged = merge_tags(["backend", "blocked", "needs-info"], plan)
    assert "blocked" not in merged
    assert "needs-info" not in merged
    assert "backend" in merged


def test_block_sets_blocked_and_stays_active() -> None:
    plan = plan_for_intent(ItemKind.BUG, TransitionIntent.BLOCK)
    assert plan.ado_state == "Active"
    assert "blocked" in plan.tags_to_add


def test_close_done_moves_to_closed() -> None:
    plan = plan_for_intent(ItemKind.STORY, TransitionIntent.CLOSE_DONE)
    assert plan.ado_state == "Closed"


def test_close_wontfix_tags_wontfix() -> None:
    plan = plan_for_intent(ItemKind.STORY, TransitionIntent.CLOSE_WONTFIX)
    assert plan.ado_state == "Closed"
    assert "wontfix" in plan.tags_to_add


def test_reopen_returns_to_active_and_clears_soft_tags() -> None:
    plan = plan_for_intent(ItemKind.STORY, TransitionIntent.REOPEN)
    assert plan.ado_state == "Active"
    merged = merge_tags(["wontfix", "p0"], plan)
    assert "wontfix" not in merged
    assert "p0" in merged


@pytest.mark.parametrize("intent", list(TransitionIntent))
def test_every_intent_has_a_plan_for_every_kind(intent: TransitionIntent) -> None:
    for kind in ItemKind:
        plan = plan_for_intent(kind, intent)
        # tag-only intents omit state; others must set one
        assert plan.ado_state in {"Active", "New", "Closed", None}
