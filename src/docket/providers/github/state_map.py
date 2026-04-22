"""State translation for the real GitHub provider.

Delegates to the same lookup tables used by the in-memory stub — GitHub's
state vocabulary does not change between fake and real — while keeping
a separate module so a future implementer can diverge (e.g., add Projects
v2 fields) without touching the stub's minimal surface."""

from __future__ import annotations

from docket.providers.github_stub.state_map import (
    INTENT_TO_NATIVE,
    NATIVE_TO_CANONICAL,
    to_canonical,
    to_native,
)

__all__ = ["INTENT_TO_NATIVE", "NATIVE_TO_CANONICAL", "to_canonical", "to_native"]
