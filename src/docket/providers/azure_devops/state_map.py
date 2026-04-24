"""Map Azure DevOps work-item types and states to the canonical model.

Supports the **Agile** process template (the default for new Azure DevOps projects).
Other templates (Scrum, CMMI, or custom) can be supported by extending KIND_BY_WIT
and STATE_BY_KIND; state-map probing during the setup wizard persists the result so
users on non-default templates don't need code changes.
"""

from __future__ import annotations

from docket.core.model import ItemKind, ItemState

# ---- work-item type name (Azure DevOps) → canonical kind -----------------------------

KIND_BY_WIT: dict[str, ItemKind] = {
    "Epic": ItemKind.EPIC,
    "Feature": ItemKind.FEATURE,
    "User Story": ItemKind.STORY,
    "Product Backlog Item": ItemKind.STORY,  # Scrum template
    "Requirement": ItemKind.STORY,  # CMMI template
    "Task": ItemKind.TASK,
    "Bug": ItemKind.BUG,
}

WIT_BY_KIND: dict[ItemKind, str] = {
    ItemKind.EPIC: "Epic",
    ItemKind.FEATURE: "Feature",
    ItemKind.STORY: "User Story",
    ItemKind.TASK: "Task",
    ItemKind.BUG: "Bug",
}


# ---- per-kind Azure DevOps state → canonical state -----------------------------------

_AGILE_STATE_MAP: dict[str, ItemState] = {
    "New": ItemState.NEW,
    "Active": ItemState.ACTIVE,
    "Resolved": ItemState.RESOLVED,
    "Closed": ItemState.CLOSED,
    "Removed": ItemState.CLOSED,  # treated as closed; archived flag set separately
}

STATE_BY_KIND: dict[ItemKind, dict[str, ItemState]] = {
    ItemKind.EPIC: dict(_AGILE_STATE_MAP),
    ItemKind.FEATURE: dict(_AGILE_STATE_MAP),
    ItemKind.STORY: dict(_AGILE_STATE_MAP),
    ItemKind.TASK: dict(_AGILE_STATE_MAP),
    ItemKind.BUG: dict(_AGILE_STATE_MAP),
}


def map_state(kind: ItemKind, state: str) -> ItemState:
    """Translate an Azure DevOps state string to canonical; unknown states fall back to ACTIVE
    so sync doesn't fail on process-template states we haven't catalogued."""
    by_kind = STATE_BY_KIND.get(kind, _AGILE_STATE_MAP)
    return by_kind.get(state, ItemState.ACTIVE)


def is_removed(state: str) -> bool:
    """Azure DevOps 'Removed' should archive the item locally. Separate from canonical state."""
    return state == "Removed"


# ---- reverse map: canonical intent → Azure DevOps write plan -------------------------

from dataclasses import dataclass  # noqa: E402

from docket.core.model import TransitionIntent  # noqa: E402


@dataclass(frozen=True)
class TransitionPlan:
    """What the provider will write to Azure DevOps for a given intent. Tags are merged with
    the item's current tags in the provider; blocked/needs-info/wontfix states are
    represented as tag flags because the default Agile template has no dedicated
    states for them."""

    state: str | None = None  # None = leave state untouched (tag-only change)
    tags_to_add: tuple[str, ...] = ()
    tags_to_remove: tuple[str, ...] = ()
    reason: str | None = None


_TAG_BLOCKED = "blocked"
_TAG_NEEDS_INFO = "needs-info"
_TAG_WONTFIX = "wontfix"
_SOFT_TAGS = (_TAG_BLOCKED, _TAG_NEEDS_INFO, _TAG_WONTFIX)


def plan_for_intent(intent: TransitionIntent) -> TransitionPlan:
    """Map a canonical intent to an Azure DevOps state + tag mutation.

    The Agile template uses the same state vocabulary for every work-item kind,
    so the plan does not depend on kind today. If a template arrives where Task
    drops Resolved (or similar per-kind difference), re-introduce a kind argument.
    """
    match intent:
        case TransitionIntent.START_WORK:
            return TransitionPlan(state="Active", tags_to_remove=_SOFT_TAGS)
        case TransitionIntent.PAUSE:
            return TransitionPlan(state="New", tags_to_remove=_SOFT_TAGS)
        case TransitionIntent.BLOCK:
            return TransitionPlan(
                state="Active",
                tags_to_add=(_TAG_BLOCKED,),
                tags_to_remove=(_TAG_NEEDS_INFO, _TAG_WONTFIX),
            )
        case TransitionIntent.NEEDS_INFO:
            return TransitionPlan(
                state="Active",
                tags_to_add=(_TAG_NEEDS_INFO,),
                tags_to_remove=(_TAG_BLOCKED, _TAG_WONTFIX),
            )
        case TransitionIntent.CLOSE_DONE:
            return TransitionPlan(state="Closed", tags_to_remove=_SOFT_TAGS)
        case TransitionIntent.CLOSE_WONTFIX:
            return TransitionPlan(
                state="Closed",
                tags_to_add=(_TAG_WONTFIX,),
                tags_to_remove=(_TAG_BLOCKED, _TAG_NEEDS_INFO),
            )
        case TransitionIntent.REOPEN:
            return TransitionPlan(state="Active", tags_to_remove=_SOFT_TAGS)


def merge_tags(current: list[str], plan: TransitionPlan) -> list[str]:
    s = {t for t in current if t}
    s.difference_update(plan.tags_to_remove)
    s.update(plan.tags_to_add)
    return sorted(s)
