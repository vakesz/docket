"""Pending-proposal registry.

The agent proposes mutations; the store holds them until a human confirms.
One process-local store, shared by agent tools (writers) and the UI (readers).

Confirmation is NOT implemented here — call sites hand the `Proposal` back to
`mutation_service.confirm(...)` after the user says yes. The store's only job
is to hold proposals long enough for the confirm UI to pick them up."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import Lock

from docket.core.mutation import Proposal


@dataclass
class PendingProposal:
    proposal: Proposal
    source: str  # "agent" | "cli" | "api" — helps the UI label where it came from


class ProposalStore:
    def __init__(self) -> None:
        self._pending: OrderedDict[str, PendingProposal] = OrderedDict()
        self._lock = Lock()

    def add(self, proposal: Proposal, *, source: str = "agent") -> str:
        with self._lock:
            self._pending[proposal.id] = PendingProposal(proposal=proposal, source=source)
            return proposal.id

    def peek_next(self) -> PendingProposal | None:
        with self._lock:
            if not self._pending:
                return None
            pending = next(iter(self._pending.values()))
            return pending

    def get(self, proposal_id: str) -> PendingProposal | None:
        with self._lock:
            return self._pending.get(proposal_id)

    def pop(self, proposal_id: str) -> PendingProposal | None:
        with self._lock:
            return self._pending.pop(proposal_id, None)

    def list(self) -> list[PendingProposal]:
        with self._lock:
            return list(self._pending.values())

    def clear(self) -> None:
        with self._lock:
            self._pending.clear()

    def __len__(self) -> int:
        return len(self._pending)
