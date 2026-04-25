"""Public entry point for the readonly tool bundle.

The actual handlers live in three private sub-modules — `_item_tools`,
`_pr_tools`, and `_commit_tools` — organized by the subject they read.
They're registered here in a fixed order because the ordered schema list
is part of the prompt prefix cache key (`tests/unit/test_tool_registration_order.py`)."""

from __future__ import annotations

import sqlite3

from docket.agent._commit_tools import register_commit_tools
from docket.agent._item_tools import register_item_tools
from docket.agent._pr_tools import register_pr_tools
from docket.agent.tools import ToolRegistry
from docket.providers.base import WorkItemProvider


def register_readonly_tools(
    registry: ToolRegistry,
    *,
    conn: sqlite3.Connection,
    provider: WorkItemProvider,
    provider_key: str = "",
) -> None:
    """Register the full read-only tool surface on `registry`.

    Registration order (load-bearing): item tools → PR tools → commit/CI
    tools. The PR and commit groups are provider-gated; each tool is
    registered only if the provider backs it. Reorder at the cost of every
    open conversation's cached prompt prefix."""
    register_item_tools(registry, conn=conn, provider=provider, provider_key=provider_key)
    register_pr_tools(registry, provider=provider)
    register_commit_tools(registry, provider=provider)


__all__ = ["register_readonly_tools"]
