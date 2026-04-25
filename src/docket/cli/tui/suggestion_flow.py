"""LLM-backed "suggest next action" flow: prompt → modal → stage or refine.

Pressing `s` (or invoking the palette command) asks the active LLM for a
next-step suggestion on the selected item, then opens `SuggestionModal` with
three terminal paths — accept (stage proposals), refine (hand the draft to the
chat pane), or dismiss. The LLM call runs in a thread worker so the UI doesn't
freeze; the modal opens via `run_worker` + `push_screen_wait` for the same
reason the review flow does (see F17).

Lifted out of `app.py` as a mixin so the cross-thread bridge (worker thread →
call_from_thread → modal coroutine) and the refine-draft formatter live in
one place. Host app must provide: `tui_ctx`, `_selected_item_id`,
`_proposals`, `_blocked_read_only`, `_refresh_pending_count`,
`_open_next_pending`."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from docket.cli.tui.widgets.chat_pane import ChatPane
from docket.cli.tui.widgets.suggestion_modal import SuggestionModal
from docket.core.services import suggestion_service
from docket.core.services.proposal_store import ProposalStore
from docket.core.services.suggestion_service import Suggestion, SuggestionError
from docket.storage.repos import item_repo

if TYPE_CHECKING:
    from textual.app import App

    from docket.cli.tui.tui_context import TuiContext

    _AppBase = App[None]
else:
    _AppBase = object

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


class SuggestionFlowMixin(_AppBase):
    """`s`-binding entry point → LLM call → SuggestionModal → stage/refine/dismiss."""

    # Host-provided attributes and helpers (declared so mypy can resolve them).
    tui_ctx: TuiContext
    _selected_item_id: str | None
    _proposals: ProposalStore

    if TYPE_CHECKING:
        # Sibling-mixin / host methods.
        def _blocked_read_only(self) -> bool: ...
        def _refresh_pending_count(self) -> None: ...
        def _open_next_pending(self) -> None: ...

    # -- action + dispatch -------------------------------------------------

    def action_suggest_next(self) -> None:
        if self._selected_item_id is None:
            self.notify("Select an item first.", severity="warning")
            return
        if self.tui_ctx.llm is None:
            self.notify("Chat/LLM is disabled.", severity="warning")
            return
        item_id = self._selected_item_id
        self.notify("Thinking about the next action…")
        self.run_worker(
            lambda iid=item_id: self._run_suggestion(iid),
            group="suggestion",
            exclusive=True,
            thread=True,
        )

    # -- worker bodies ----------------------------------------------------

    def _run_suggestion(self, item_id: str) -> None:
        item = item_repo.get_item(
            self.tui_ctx.conn, item_id, provider_key=self.tui_ctx.provider_key
        )
        if item is None:
            self.call_from_thread(self.notify, f"Item {item_id} is gone.", severity="error")
            return
        llm = self.tui_ctx.llm
        if llm is None:
            self.call_from_thread(self.notify, "Chat/LLM is disabled.", severity="warning")
            return
        try:
            suggestion = suggestion_service.suggest_next_action(
                self.tui_ctx.conn,
                llm,
                item,
            )
        except SuggestionError as e:
            self.call_from_thread(self.notify, f"Suggestion failed: {e}", severity="error")
            return
        except Exception as e:
            log.exception("suggestion failed for %s", item_id)
            self.call_from_thread(self.notify, f"Suggestion failed: {e}", severity="error")
            return
        self.call_from_thread(self._show_suggestion_modal, suggestion)

    def _show_suggestion_modal(self, suggestion: Suggestion) -> None:
        self.run_worker(
            self._suggestion_modal_flow(suggestion),
            group="suggestion-modal",
            exclusive=False,
        )

    async def _suggestion_modal_flow(self, suggestion: Suggestion) -> None:
        decision = await self.push_screen_wait(SuggestionModal(suggestion))
        if decision == "refine":
            self._refine_suggestion_in_chat(suggestion)
            return
        if decision != "accept":
            self.notify("Suggestion dismissed.", severity="information")
            return
        if self._blocked_read_only():
            return
        try:
            staged = suggestion_service.stage_suggestion(
                self.tui_ctx.conn,
                suggestion,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception as e:
            self.notify(f"Failed to stage: {e}", severity="error")
            return
        self._proposals.add(staged.state_change, source="suggestion")
        if staged.description_patch is not None:
            self._proposals.add(staged.description_patch, source="suggestion")
        self._refresh_pending_count()
        self.notify(
            f"Staged {1 if staged.description_patch is None else 2} proposal(s); "
            "press 'd' to review.",
            severity="information",
        )
        self._open_next_pending()

    def _refine_suggestion_in_chat(self, suggestion: Suggestion) -> None:
        """Hand a suggestion to the chat pane as an editable draft.

        Mirrors the frontend "Refine in chat" affordance — the user can edit
        the draft before pressing Enter, and nothing is staged unless they
        come back to Suggest later or the agent stages something itself."""
        chat = self.query_one(ChatPane)
        chat.seed_input(_format_suggestion_for_chat(suggestion))
        self.notify(
            "Suggestion moved to chat — edit and press Enter to refine.",
            severity="information",
        )


__all__ = ["SuggestionFlowMixin"]
