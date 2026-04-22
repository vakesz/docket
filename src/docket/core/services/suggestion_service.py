"""Suggested next action.

One-shot LLM call that, given the current item snapshot, returns a structured
triage recommendation:

    {
      "intent": "start_work" | "needs_info" | "close_wontfix" | ... ,
      "description_patch_md": "..." or "",
      "open_questions": ["...", ...]
    }

The caller (TUI) renders this in a modal. If the user accepts, we stage a
`state_change` proposal (and a `description_patch` proposal when the patch
is non-empty) via the normal proposal pipeline — no auto-apply.

Why a dedicated path and not just the chat loop: the user's ask is "what's
the obvious next move here?" — a one-shot response is the contract, not a
conversation. Keeping it out of the chat transcript also means suggestions
don't pollute future chat turns with stale recommendations.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from docket.agent.llm_client import LlmClient
from docket.agent.prompt import build_prefix
from docket.agent.types import ChatMessage
from docket.core.model import Item, TransitionIntent
from docket.core.mutation import DescriptionPatch, StateChange
from docket.core.services import mutation_service
from docket.storage.repos import comment_repo

log = logging.getLogger(__name__)


_ALLOWED_INTENTS = [i.value for i in TransitionIntent]

_USER_PROMPT = f"""Based on the ticket snapshot above, recommend the single next triage action.

Respond with ONLY a JSON object — no prose, no code fences — in this exact shape:
{{
  "intent": "<one of: {", ".join(_ALLOWED_INTENTS)}>",
  "description_patch_md": "<improved description, or empty string if the current one is fine>",
  "open_questions": ["<short question>", ...]
}}

Rules:
- Pick the transition that best matches the ticket's real next move. If none apply, use the closest intent but raise it in open_questions.
- Only suggest a description patch when the current text is missing, unclear, or stale. A good patch clarifies acceptance criteria, repro steps, or scope.
- open_questions is for blockers you cannot resolve from the snapshot alone. Keep each under 120 characters. Empty list if nothing is unclear.
- Do not invent linked tickets, authors, or dates."""


@dataclass
class Suggestion:
    item_id: str
    intent: TransitionIntent
    description_patch_md: str
    open_questions: list[str] = field(default_factory=list)


@dataclass
class StagedSuggestion:
    """Result of turning a Suggestion into queued proposals. The TUI hands these
    to `ProposalStore.add(...)` so the normal confirm flow can pick them up."""

    state_change: StateChange
    description_patch: DescriptionPatch | None


class SuggestionError(RuntimeError):
    """Raised when the model returns output we cannot parse into a Suggestion."""


def suggest_next_action(
    conn: sqlite3.Connection,
    llm: LlmClient,
    item: Item,
) -> Suggestion:
    """Ask the model for a one-shot triage recommendation.

    Raises SuggestionError if the response is malformed — callers surface that
    to the UI as a toast rather than retrying silently."""
    comments = comment_repo.list_comments(conn, item.id)
    prefix = build_prefix(item, comments)
    messages: list[ChatMessage] = [*prefix, ChatMessage(role="user", content=_USER_PROMPT)]
    result = llm.complete(messages, [])
    raw = (result.message.content or "").strip()
    return _parse(item.id, raw)


def stage_suggestion(
    conn: sqlite3.Connection,
    suggestion: Suggestion,
) -> StagedSuggestion:
    """Turn an accepted Suggestion into ready-to-confirm proposals. The caller
    is responsible for pushing them into the ProposalStore."""
    state_change = mutation_service.propose_transition(conn, suggestion.item_id, suggestion.intent)
    desc_patch: DescriptionPatch | None = None
    patch_text = suggestion.description_patch_md.strip()
    if patch_text:
        desc_patch = mutation_service.propose_description_patch(
            conn, suggestion.item_id, patch_text
        )
    return StagedSuggestion(state_change=state_change, description_patch=desc_patch)


def _parse(item_id: str, raw: str) -> Suggestion:
    payload = _extract_json(raw)
    try:
        intent = TransitionIntent(payload["intent"])
    except (KeyError, ValueError) as e:
        raise SuggestionError(f"model returned unknown intent: {payload.get('intent')!r}") from e
    description_patch = payload.get("description_patch_md", "") or ""
    if not isinstance(description_patch, str):
        raise SuggestionError("description_patch_md must be a string")
    questions_raw = payload.get("open_questions") or []
    if not isinstance(questions_raw, list):
        raise SuggestionError("open_questions must be a list")
    questions = [str(q).strip() for q in questions_raw if str(q).strip()]
    return Suggestion(
        item_id=item_id,
        intent=intent,
        description_patch_md=description_patch,
        open_questions=questions,
    )


def _extract_json(raw: str) -> dict[str, Any]:
    """Be lenient about stray fencing / leading prose. The prompt forbids it,
    but models still slip up — one fallback attempt is cheap and keeps the
    happy path smooth."""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise SuggestionError("model did not return JSON") from None
        try:
            obj = json.loads(raw[start : end + 1])
        except json.JSONDecodeError as e:
            raise SuggestionError(f"model returned malformed JSON: {e}") from e
    if not isinstance(obj, dict):
        raise SuggestionError("top-level JSON must be an object")
    return obj


__all__ = [
    "StagedSuggestion",
    "Suggestion",
    "SuggestionError",
    "stage_suggestion",
    "suggest_next_action",
]
