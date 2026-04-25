"""Pending-proposal review — diff modal and batch modal flows.

Every mutation path in Docket stages a `Proposal` into `self._proposals`; this
mixin is what drains that queue. One pending proposal opens the single-item
`DiffModal`; two or more open the `BatchDiffModal`. Both run inside Textual
workers so `push_screen_wait` doesn't block the action dispatcher (which would
starve test pilots and key handling — see F17 for the call-site rationale).

Lifted out of `app.py` as a mixin so the chain-drain bookkeeping (pop → notify
→ reload → re-enter the queue) lives in one place alongside the modal wiring.
Host app must provide: `tui_ctx`, `_proposals`, `_refresh_pending_count`,
`_reload_tree`."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.errors import retry_hint
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.core.services import mutation_service
from docket.core.services.proposal_store import PendingProposal, ProposalStore

if TYPE_CHECKING:
    from textual.app import App

    from docket.cli.tui.tui_context import TuiContext

    _AppBase = App[None]
else:
    _AppBase = object

log = logging.getLogger(__name__)


class ReviewFlowMixin(_AppBase):
    """Drain the pending-proposal queue via diff / batch-diff modals."""

    # Host-provided attributes and helpers (declared so mypy can resolve them).
    tui_ctx: TuiContext
    _proposals: ProposalStore

    if TYPE_CHECKING:
        # Sibling-mixin methods (live on ItemSelectionMixin / DocketApp).
        def _refresh_pending_count(self) -> None: ...
        def _reload_tree(self) -> None: ...

    # -- action + dispatch -------------------------------------------------

    def action_review_pending(self) -> None:
        if len(self._proposals) == 0:
            self.notify("No pending proposals.", severity="information")
            return
        self._open_next_pending()

    def _open_next_pending(self) -> None:
        count = len(self._proposals)
        if count == 0:
            return
        if count >= 2:
            # Batch review: one modal covers the whole queue so the user can
            # apply-all / apply-selected / reject-all in a single pass.
            self._open_batch_review()
            return

        pending = self._proposals.peek_next()
        if pending is None:
            return
        self.run_worker(self._review_single(pending), group="review", exclusive=False)

    def _open_batch_review(self) -> None:
        """Open the batch modal with a snapshot of every pending proposal.

        Snapshotting up front means new proposals that land while the modal
        is open stay queued for the next review pass — we don't want the
        list shifting under the user mid-review."""
        pendings = self._proposals.list()
        if not pendings:
            return
        self.run_worker(self._review_batch(pendings), group="review", exclusive=False)

    # -- worker bodies ----------------------------------------------------

    async def _review_single(self, pending: PendingProposal) -> None:
        edited = await self.push_screen_wait(DiffModal(pending.proposal, source=pending.source))
        # peek_next did not remove; we drain here.
        popped = self._proposals.pop(pending.proposal.id)
        self._refresh_pending_count()
        if popped is None:
            return
        if edited is None:
            self.notify("Rejected.", severity="warning")
            return
        # The modal returns the (possibly edited) proposal — use that
        # when confirming so description-patch edits flow through.
        try:
            result = mutation_service.confirm(
                self.tui_ctx.conn,
                self.tui_ctx.provider,
                edited,
                provider_key=self.tui_ctx.provider_key,
            )
        except Exception as e:
            self.notify(
                f"{humanize_error(e, action='Apply')} {retry_hint('d', 'review')}",
                severity="error",
            )
            return
        self._reload_tree()
        if result.attachment_url:
            self.notify(f"Uploaded → {result.attachment_url}", severity="information")
        elif result.item is not None:
            self.notify(f"Applied · {result.item.id} now {result.item.state.value}")
        else:
            self.notify("Applied.")
        # Chain-drain: if more pending, pop up the next modal.
        if len(self._proposals) > 0:
            self._open_next_pending()

    async def _review_batch(self, pendings: list[PendingProposal]) -> None:
        decision = await self.push_screen_wait(BatchDiffModal(pendings))
        if decision is None:
            # Cancel: queue unchanged, user can come back later.
            return
        # Drop rejected ids first — they never touch the provider.
        rejected = sum(1 for pid in decision.reject if self._proposals.pop(pid) is not None)
        applied = 0
        failed = 0
        for pid in decision.apply:
            popped = self._proposals.pop(pid)
            if popped is None:
                continue
            try:
                mutation_service.confirm(
                    self.tui_ctx.conn,
                    self.tui_ctx.provider,
                    popped.proposal,
                    provider_key=self.tui_ctx.provider_key,
                )
                applied += 1
            except Exception as e:
                log.exception("batch apply failed for %s", pid)
                self.notify(
                    f"{humanize_error(e, action=f'Apply {pid}')}",
                    severity="error",
                )
                failed += 1
        self._refresh_pending_count()
        if applied or rejected or failed:
            self._reload_tree()
            parts = [f"applied {applied}", f"rejected {rejected}"]
            if failed:
                parts.append(f"failed {failed}")
            self.notify("Batch · " + ", ".join(parts) + ".")
        # If more proposals trickled in while we were reviewing, chain.
        if len(self._proposals) > 0:
            self._open_next_pending()


__all__ = ["ReviewFlowMixin"]
