"""Pending-question registry.

In-memory, process-local, single-pending-per-conversation. Mirrors
`ProposalStore` shape so surfaces (CLI/TUI/API) can wire it the same way.

Conversation key is `(provider_key, project_id, conversation_id)` — a
provider/project switch rebuilds the agent and any pending question is
abandoned along with the closure that staged it.
"""

from __future__ import annotations

from threading import Lock

from docket.core.question import Question

ConvoKey = tuple[str, str, str]


class QuestionStore:
    def __init__(self) -> None:
        self._pending: dict[ConvoKey, Question] = {}
        self._lock = Lock()

    @staticmethod
    def key_for(question: Question) -> ConvoKey:
        return (question.provider_key, question.project_id, question.conversation_id)

    def stage(self, question: Question) -> str:
        with self._lock:
            self._pending[self.key_for(question)] = question
            return question.id

    def peek(self, key: ConvoKey) -> Question | None:
        with self._lock:
            return self._pending.get(key)

    def get(self, question_id: str) -> Question | None:
        with self._lock:
            for q in self._pending.values():
                if q.id == question_id:
                    return q
            return None

    def pop(self, key: ConvoKey) -> Question | None:
        with self._lock:
            return self._pending.pop(key, None)

    def list(self) -> list[Question]:
        with self._lock:
            return list(self._pending.values())

    def clear(self) -> None:
        with self._lock:
            self._pending.clear()

    def __len__(self) -> int:
        return len(self._pending)
