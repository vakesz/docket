"""State translation for the GitHub Issues stub.

GitHub Issues are a two-state system (`open`, `closed`) with a
`state_reason` field (`completed`, `not_planned`, `reopened`). Our canonical
ItemState has six states; the mapping below flattens gracefully in both
directions without losing triage-level fidelity.

Implementers writing a real GitHub provider can keep this file structure and
just swap the lookup tables.
"""
from __future__ import annotations

from docket.core.model import ItemState, TransitionIntent


# GitHub native state → canonical ItemState.
# "closed+completed" → RESOLVED, "closed+not_planned" → CLOSED, everything
# else collapses to ACTIVE because GitHub has no explicit "blocked" etc.
NATIVE_TO_CANONICAL: dict[tuple[str, str], ItemState] = {
    ("open", ""): ItemState.ACTIVE,
    ("open", "reopened"): ItemState.ACTIVE,
    ("closed", "completed"): ItemState.RESOLVED,
    ("closed", "not_planned"): ItemState.CLOSED,
}


# TransitionIntent → the native (state, state_reason) write.
# This is the asymmetric direction: the agent can ask for any intent; the
# provider decides how to implement it given its native vocabulary.
INTENT_TO_NATIVE: dict[TransitionIntent, tuple[str, str]] = {
    TransitionIntent.START_WORK: ("open", ""),
    TransitionIntent.PAUSE: ("open", ""),
    TransitionIntent.BLOCK: ("open", ""),
    TransitionIntent.NEEDS_INFO: ("open", ""),
    TransitionIntent.CLOSE_DONE: ("closed", "completed"),
    TransitionIntent.CLOSE_WONTFIX: ("closed", "not_planned"),
    TransitionIntent.REOPEN: ("open", "reopened"),
}


def to_canonical(native_state: str, native_reason: str) -> ItemState:
    key = (native_state, native_reason)
    state = NATIVE_TO_CANONICAL.get(key)
    if state is not None:
        return state
    # Fallback: open → ACTIVE, closed → CLOSED. Safer than raising because
    # GitHub occasionally ships new reason strings.
    return ItemState.ACTIVE if native_state == "open" else ItemState.CLOSED


def to_native(intent: TransitionIntent) -> tuple[str, str]:
    return INTENT_TO_NATIVE[intent]


__all__ = ["INTENT_TO_NATIVE", "NATIVE_TO_CANONICAL", "to_canonical", "to_native"]
