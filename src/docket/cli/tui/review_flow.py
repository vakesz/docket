"""Pending-proposal review — diff modal and batch modal flows.

Every mutation path in Docket stages a `Proposal` into `app._proposals`; this
module is what drains that queue. One pending proposal opens the single-item
`DiffModal`; two or more open the `BatchDiffModal`. Both run inside Textual
workers so `push_screen_wait` doesn't block the action dispatcher (which would
starve test pilots and key handling — see F17 for the call-site rationale).

Free helpers, not a mixin: `DocketApp` keeps a thin `action_review_pending`
delegate so Textual's binding dispatcher can resolve it, but the chain-drain
bookkeeping (pop → notify → reload → re-enter the queue) lives here as
`app: DocketApp` callables."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from docket.cli.tui.errors import humanize as humanize_error
from docket.cli.tui.errors import retry_hint
from docket.cli.tui.widgets.batch_diff_modal import BatchDiffModal
from docket.cli.tui.widgets.diff_modal import DiffModal
from docket.core.services import mutation_service
from docket.core.services.proposal_store import PendingProposal

if TYPE_CHECKING:
    from docket.cli.tui.app import DocketApp

log = logging.getLogger(__name__)


def review_pending(app: DocketApp) -> None:
    if len(app._proposals) == 0:
        app.notify("No pending proposals.", severity="information")
        return
    _open_next_pending(app)


def _open_next_pending(app: DocketApp) -> None:
    count = len(app._proposals)
    if count == 0:
        return
    if count >= 2:
        # Batch review: one modal covers the whole queue so the user can
        # apply-all / apply-selected / reject-all in a single pass.
        _open_batch_review(app)
        return

    pending = app._proposals.peek_next()
    if pending is None:
        return
    app.run_worker(_review_single(app, pending), group="review", exclusive=False)


def _open_batch_review(app: DocketApp) -> None:
    """Open the batch modal with a snapshot of every pending proposal.

    Snapshotting up front means new proposals that land while the modal
    is open stay queued for the next review pass — we don't want the
    list shifting under the user mid-review."""
    pendings = app._proposals.list()
    if not pendings:
        return
    app.run_worker(_review_batch(app, pendings), group="review", exclusive=False)


async def _review_single(app: DocketApp, pending: PendingProposal) -> None:
    edited = await app.push_screen_wait(DiffModal(pending.proposal, source=pending.source))
    # peek_next did not remove; we drain here.
    popped = app._proposals.pop(pending.proposal.id)
    app._refresh_pending_count()
    if popped is None:
        return
    if edited is None:
        app.notify("Rejected.", severity="warning")
        return
    # The modal returns the (possibly edited) proposal — use that
    # when confirming so description-patch edits flow through.
    try:
        result = mutation_service.confirm(
            app.tui_ctx.conn,
            app.tui_ctx.provider,
            edited,
            provider_key=app.tui_ctx.provider_key,
        )
    except Exception as e:
        app.notify(
            f"{humanize_error(e, action='Apply')} {retry_hint('d', 'review')}",
            severity="error",
        )
        return
    app._reload_tree()
    if result.attachment_url:
        app.notify(f"Uploaded → {result.attachment_url}", severity="information")
    elif result.item is not None:
        app.notify(f"Applied · {result.item.id} now {result.item.state.value}")
    else:
        app.notify("Applied.")
    # Chain-drain: if more pending, pop up the next modal.
    if len(app._proposals) > 0:
        _open_next_pending(app)


async def _review_batch(app: DocketApp, pendings: list[PendingProposal]) -> None:
    decision = await app.push_screen_wait(BatchDiffModal(pendings))
    if decision is None:
        # Cancel: queue unchanged, user can come back later.
        return
    # Drop rejected ids first — they never touch the provider.
    rejected = sum(1 for pid in decision.reject if app._proposals.pop(pid) is not None)
    applied = 0
    failed = 0
    for pid in decision.apply:
        popped = app._proposals.pop(pid)
        if popped is None:
            continue
        try:
            mutation_service.confirm(
                app.tui_ctx.conn,
                app.tui_ctx.provider,
                popped.proposal,
                provider_key=app.tui_ctx.provider_key,
            )
            applied += 1
        except Exception as e:
            log.exception("batch apply failed for %s", pid)
            app.notify(
                f"{humanize_error(e, action=f'Apply {pid}')}",
                severity="error",
            )
            failed += 1
    app._refresh_pending_count()
    if applied or rejected or failed:
        app._reload_tree()
        parts = [f"applied {applied}", f"rejected {rejected}"]
        if failed:
            parts.append(f"failed {failed}")
        app.notify("Batch · " + ", ".join(parts) + ".")
    # If more proposals trickled in while we were reviewing, chain.
    if len(app._proposals) > 0:
        _open_next_pending(app)


__all__ = ["review_pending"]
