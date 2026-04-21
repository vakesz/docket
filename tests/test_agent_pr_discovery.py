"""`find_related_prs` agent tool gating.

The plan (§M16) says: providers that can't search PRs return
`NotImplementedError` and the tool is hidden in the agent's registry so
the model never hallucinates PR URLs.

We exercise both directions — provider with support registers the tool
and the tool maps results faithfully; provider without support does not
register the tool."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from docket.agent.tool_defs import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.model import PRMatch
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


class _PrDiscoveringProvider(FakeProvider):
    """FakeProvider + a scripted `find_related_prs` implementation."""

    def find_related_prs(self, item_id: str, title_keywords: list[str]) -> list[PRMatch]:
        return [
            PRMatch(
                url="https://example.test/pull/1",
                title=f"Fix {item_id}",
                branch="feature/x",
                state="merged",
                author="alice",
                confidence=0.9,
            )
        ]


def _fresh_conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "t.db")


def test_tool_hidden_when_provider_lacks_support(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=FakeProvider())
    assert "find_related_prs" not in registry


def test_tool_registered_when_provider_supports_it(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(
        registry, conn=_fresh_conn(tmp_path), provider=_PrDiscoveringProvider()
    )
    assert "find_related_prs" in registry


def test_tool_maps_prmatch_list_to_json(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(
        registry, conn=_fresh_conn(tmp_path), provider=_PrDiscoveringProvider()
    )
    out = registry.dispatch("find_related_prs", {"id": "item-1", "title_keywords": ["login"]})
    data = json.loads(out)
    assert len(data) == 1
    assert data[0]["url"] == "https://example.test/pull/1"
    assert data[0]["state"] == "merged"
    assert data[0]["confidence"] == 0.9


def test_tool_surfaces_provider_errors_without_raising(tmp_path: Path) -> None:
    class _BoomProvider(FakeProvider):
        def find_related_prs(self, item_id: str, title_keywords: list[str]) -> list[PRMatch]:
            raise RuntimeError("rate limited")

    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_fresh_conn(tmp_path), provider=_BoomProvider())
    out = registry.dispatch("find_related_prs", {"id": "item-1"})
    assert "rate limited" in json.loads(out)["error"]


def test_not_implemented_error_maps_to_soft_error(tmp_path: Path) -> None:
    """A provider that declares the method but raises NotImplementedError
    (e.g. the `github_stub` reference impl) must surface as a tool error,
    never take down the chat turn."""

    class _UnsupportedProvider(FakeProvider):
        def find_related_prs(self, item_id: str, title_keywords: list[str]) -> list[PRMatch]:
            raise NotImplementedError

    registry = ToolRegistry()
    register_readonly_tools(
        registry, conn=_fresh_conn(tmp_path), provider=_UnsupportedProvider()
    )
    out = registry.dispatch("find_related_prs", {"id": "item-1"})
    assert "does not support" in json.loads(out)["error"]
