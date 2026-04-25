"""LLM-backed "suggest next action" flow: prompt → modal → stage or refine.

Pressing `s` (or invoking the palette command) asks the active LLM for a
next-step suggestion on the selected item, then opens `SuggestionModal` with
three terminal paths — accept (stage proposals), refine (hand the draft to the
chat pane), or dismiss. The LLM call runs in a thread worker so the UI doesn't
freeze; the modal opens via `run_worker` + `push_screen_wait` for the same
reason the review flow does (see F17).

Free helpers, not a mixin: `DocketApp` keeps a thin `action_suggest_next`
delegate so Textual's binding dispatcher can resolve it, but the cross-thread
bridge (worker thread → call_from_thread → modal coroutine) and the refine-
draft formatter live here as `app: DocketApp` callables."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.core.services import suggestion_service
from docket.core.services.suggestion_service import Suggestion, SuggestionError
from docket.storage.repos import item_repo

if TYPE_CHECKING:
    from docket.cli.tui.app import DocketApp

log = logging.getLogger(__name__)


def _format_suggestion_for_chat(suggestion: Suggestion) -> str:
    """Render a suggestion as an editable chat draft.

    Kept close to the frontend's `refinementDraft` so the UX is consistent
    when the user moves between TUI and web — same opening line, same
    sectioning, same trailing prompt."""
    lines: list[str] = [f"About the suggested next action ({suggestion.intent.value}):"]
    patch = (suggestion.description_patch_md or "").strip()
    if patch:
        lines += ["", "Proposed description patch:", patch]
    if suggestion.open_questions:
        lines += ["", "Open questions:"]
        lines += [f"- {q}" for q in suggestion.open_questions]
    lines += ["", "I'd like to refine this before staging — what do you think?"]
    return "\n".join(lines)


def suggest_next(app: DocketApp) -> None:
    if app._selected_item_id is None:
        app.notify("Select an item first.", severity="warning")
        return
    if app.tui_ctx.llm is None:
        app.notify("Chat/LLM is disabled.", severity="warning")
        return
    item_id = app._selected_item_id
    app.notify("Thinking about the next action…")
    app.run_worker(
        lambda iid=item_id: _run_suggestion(app, iid),
        group="suggestion",
        exclusive=True,
        thread=True,
    )


def _run_suggestion(app: DocketApp, item_id: str) -> None:
    item = item_repo.get_item(app.tui_ctx.conn, item_id, provider_key=app.tui_ctx.provider_key)
    if item is None:
        app.call_from_thread(app.notify, f"Item {item_id} is gone.", severity="error")
        return
    llm = app.tui_ctx.llm
    if llm is None:
        app.call_from_thread(app.notify, "Chat/LLM is disabled.", severity="warning")
        return
    try:
        suggestion = suggestion_service.suggest_next_action(
            app.tui_ctx.conn,
            llm,
            item,
        )
    except SuggestionError as e:
        app.call_from_thread(app.notify, f"Suggestion failed: {e}", severity="error")
        return
    except Exception as e:
        log.exception("suggestion failed for %s", item_id)
        app.call_from_thread(app.notify, f"Suggestion failed: {e}", severity="error")
        return
    app.call_from_thread(_show_suggestion_modal, app, suggestion)


def _show_suggestion_modal(app: DocketApp, suggestion: Suggestion) -> None:
    app.run_worker(
        _suggestion_modal_flow(app, suggestion),
        group="suggestion-modal",
        exclusive=False,
    )


async def _suggestion_modal_flow(app: DocketApp, suggestion: Suggestion) -> None:
    decision = await app.push_screen_wait(SuggestionModal(suggestion))
    if decision == "refine":
        _refine_suggestion_in_chat(app, suggestion)
        return
    if decision != "accept":
        app.notify("Suggestion dismissed.", severity="information")
        return
    if app._blocked_read_only():
        return
    try:
        staged = suggestion_service.stage_suggestion(
            app.tui_ctx.conn,
            suggestion,
            provider_key=app.tui_ctx.provider_key,
        )
    except Exception as e:
        app.notify(f"Failed to stage: {e}", severity="error")
        return
    app._proposals.add(staged.state_change, source="suggestion")
    if staged.description_patch is not None:
        app._proposals.add(staged.description_patch, source="suggestion")
    app._refresh_pending_count()
    app.notify(
        f"Staged {1 if staged.description_patch is None else 2} proposal(s); press 'd' to review.",
        severity="information",
    )
    app._open_next_pending()


def _refine_suggestion_in_chat(app: DocketApp, suggestion: Suggestion) -> None:
    """Hand a suggestion to the chat pane as an editable draft.

    Mirrors the frontend "Refine in chat" affordance — the user can edit
    the draft before pressing Enter, and nothing is staged unless they
    come back to Suggest later or the agent stages something itself."""
    chat = app.query_one(ChatPane)
    chat.seed_input(_format_suggestion_for_chat(suggestion))
    app.notify(
        "Suggestion moved to chat — edit and press Enter to refine.",
        severity="information",
    )


__all__ = ["suggest_next"]
