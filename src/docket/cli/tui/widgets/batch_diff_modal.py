"""Batch-review modal for multiple pending proposals.

When the agent stashes several `propose_*` calls in a single turn (or the user
queues proposals from multiple sources), we want a *single review pass*
instead of a y/n chain. This modal lists every pending proposal with its
inline diff and a checkbox, then dismisses with a `BatchDecision` telling the
app which ids to apply and which to drop.

Contract:
  - `apply`  — confirm these ids in original queue order
  - `reject` — drop these ids without confirming
  - Cancel (Esc) dismisses with `None`; the queue is left untouched so the
    user can come back via the palette / `d` keybind later.

The routing decision lives in `DocketApp._open_next_pending`: length ≥ 2 opens
the batch modal, a single proposal keeps using `DiffModal`. That keeps the
single-proposal ergonomics unchanged and confines the batch UX to the case
where it actually helps.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Checkbox, Static

from docket.core.mutation import (
    AttachmentUpload,
    DescriptionPatch,
    ItemCreate,
    Proposal,
    StateChange,
    render_diff,
)
from docket.core.services.proposal_store import PendingProposal


@dataclass(frozen=True)
class BatchDecision:
    """Result of a batch review.

    `apply` and `reject` partition the reviewed proposal ids — every id that
    went in comes out in exactly one of the two lists. Cancel is represented
    by dismissing with `None`, not an empty `BatchDecision`, so the caller
    can distinguish "user rejected nothing" from "user didn't decide yet"."""

    apply: list[str] = field(default_factory=list)
    reject: list[str] = field(default_factory=list)


class BatchDiffModal(ModalScreen["BatchDecision | None"]):
    """Review several pending proposals at once.

    Each proposal gets a Checkbox (all pre-checked so `a`/`y` both "apply
    all" by default) plus its rendered diff. The user can uncheck rows they
    want dropped and press `y`, or hit `a`/`r` for apply-all/reject-all."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("a", "apply_all", "Apply all", priority=True),
        Binding("y", "apply_selected", "Apply selected", priority=True),
        Binding("r", "reject_all", "Reject all", priority=True),
        Binding("escape", "cancel", "Cancel", priority=True),
    ]

    DEFAULT_CSS = """
    BatchDiffModal { align: center middle; }
    BatchDiffModal > Vertical {
        width: 85%;
        max-width: 140;
        height: auto;
        max-height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    BatchDiffModal #batch-title { color: $text-muted; padding-bottom: 1; }
    BatchDiffModal #batch-list { height: auto; max-height: 70%; }
    BatchDiffModal .batch-diff {
        padding: 0 0 1 4;
        color: $text-muted;
    }
    BatchDiffModal #batch-hint { color: $text-muted; padding-top: 1; }
    """

    def __init__(self, pendings: list[PendingProposal]) -> None:
        super().__init__()
        self._pendings = list(pendings)

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(
                f"[b]Review {len(self._pendings)} pending proposal(s)[/b]",
                id="batch-title",
            )
            with VerticalScroll(id="batch-list"):
                for pending in self._pendings:
                    p = pending.proposal
                    yield Checkbox(
                        _summary(p, pending.source),
                        value=True,
                        id=f"cb-{p.id}",
                    )
                    yield Static(render_diff(p), classes="batch-diff")
            yield Static(
                "[b]a[/b] apply-all  ·  [b]y[/b] apply-selected  ·  "
                "[b]r[/b] reject-all  ·  [b]space[/b] toggle  ·  [b]esc[/b] cancel",
                id="batch-hint",
            )

    def _all_ids(self) -> list[str]:
        return [p.proposal.id for p in self._pendings]

    def _checked_ids(self) -> list[str]:
        out: list[str] = []
        for pending in self._pendings:
            cb = self.query_one(f"#cb-{pending.proposal.id}", Checkbox)
            if cb.value:
                out.append(pending.proposal.id)
        return out

    def action_apply_all(self) -> None:
        self.dismiss(BatchDecision(apply=self._all_ids(), reject=[]))

    def action_apply_selected(self) -> None:
        checked = set(self._checked_ids())
        apply = [pid for pid in self._all_ids() if pid in checked]
        reject = [pid for pid in self._all_ids() if pid not in checked]
        self.dismiss(BatchDecision(apply=apply, reject=reject))

    def action_reject_all(self) -> None:
        self.dismiss(BatchDecision(apply=[], reject=self._all_ids()))

    def action_cancel(self) -> None:
        self.dismiss(None)


def _summary(proposal: Proposal, source: str) -> str:
    """One-line label for a proposal's Checkbox row.

    Bracketed ids are escaped so Rich doesn't treat `[S-1]` as markup."""
    tag = f"\\[{source}]"
    if isinstance(proposal, StateChange):
        return f"{tag} {proposal.kind} · \\[{proposal.item.id}] → {proposal.intent.value}"
    if isinstance(proposal, DescriptionPatch):
        return f"{tag} {proposal.kind} · \\[{proposal.item.id}] description"
    if isinstance(proposal, AttachmentUpload):
        return f"{tag} {proposal.kind} · \\[{proposal.item.id}] + {proposal.filename}"
    if isinstance(proposal, ItemCreate):
        return f"{tag} {proposal.kind} · new {proposal.item_kind.value}: {proposal.fields.title}"
    return f"{tag} {proposal.kind}"


__all__ = ["BatchDecision", "BatchDiffModal"]
