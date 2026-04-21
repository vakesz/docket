"""GitHub Issues stub provider.

This is not a production integration. It exists to prove that the
`WorkItemProvider` interface is flexible enough for a system whose native
state space (open/closed) is much shallower than Azure DevOps's. Anyone
implementing a real GitHub provider should follow this structure:

    * A state map (`state_map.py`) that translates native state ↔ ItemState
      and TransitionIntent → the write operation the remote expects.
    * A provider class implementing the full WorkItemProvider Protocol.
    * A thin package __init__ re-exporting the class.

The stub keeps items in memory and is useful as a scripted backend for
docs, demos, and cross-provider tests.
"""
from __future__ import annotations

from docket.providers.github_stub.provider import GitHubStubProvider

__all__ = ["GitHubStubProvider"]
