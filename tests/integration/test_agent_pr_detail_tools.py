"""Contract tests for the new PR/commit/CI detail tools.

Mirrors `test_agent_pr_discovery.py` — providers that don't expose the
methods leave the tools hidden; providers that do expose them round-trip
through the registry with the canonical dataclass → JSON mapping intact."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from docket.agent.factory import register_readonly_tools
from docket.agent.tools import ToolRegistry
from docket.core.model import (
    CIRun,
    CIStatus,
    CommitDetail,
    PullRequestDetail,
    PullRequestFile,
    PullRequestReview,
)
from docket.storage import init_db
from tests.fakes.provider import FakeProvider


def _conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "t.db")


class _DetailProvider(FakeProvider):
    """FakeProvider that scripts the full new-tool surface."""

    def get_pull_request(self, pr_id: str) -> PullRequestDetail:
        return PullRequestDetail(
            id=pr_id,
            url="https://example.test/pull/42",
            title="Fix login",
            number=42,
            state="merged",
            author="alice",
            body_md="Closes #10",
            head_ref="feature/login",
            base_ref="main",
            head_sha="deadbeef",
            draft=False,
            merged=True,
            mergeable=None,
            labels=["bug"],
            requested_reviewers=["bob"],
            additions=10,
            deletions=2,
            changed_files=1,
            files=[PullRequestFile(path="a.py", status="modified", additions=10, deletions=2)],
            reviews=[
                PullRequestReview(
                    author="bob",
                    state="APPROVED",
                    body_md="lgtm",
                    submitted_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
                )
            ],
            comments_count=3,
            review_comments_count=1,
            updated_at=datetime(2026, 1, 2, 12, 0, tzinfo=UTC),
        )

    def get_pull_request_diff(self, pr_id: str) -> str:
        return f"--- diff for {pr_id} ---"

    def get_commit(self, ref: str) -> CommitDetail:
        return CommitDetail(
            sha="deadbeef",
            url="https://example.test/commit/deadbeef",
            author="alice",
            author_email="alice@example.com",
            committer="alice",
            committed_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
            message="Fix login",
            parents=["cafef00d"],
            additions=10,
            deletions=2,
            files=[PullRequestFile(path="a.py", status="modified", additions=10, deletions=2)],
        )

    def get_commit_diff(self, ref: str) -> str:
        return f"--- commit diff for {ref} ---"

    def get_ci_status(self, ref: str) -> CIStatus:
        return CIStatus(
            ref=ref,
            overall="success",
            runs=[
                CIRun(
                    id="99",
                    name="test",
                    status="completed",
                    conclusion="success",
                    url="https://example.test/runs/99",
                    head_sha="deadbeef",
                    started_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
                    completed_at=datetime(2026, 1, 1, 12, 5, tzinfo=UTC),
                )
            ],
        )


def test_detail_tools_hidden_on_basic_provider(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=FakeProvider())
    for tool in (
        "get_pull_request",
        "get_pull_request_diff",
        "get_commit",
        "get_diff",
        "get_ci_status",
    ):
        assert tool not in registry


def test_detail_tools_registered_when_provider_supports(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    for tool in (
        "get_pull_request",
        "get_pull_request_diff",
        "get_commit",
        "get_diff",
        "get_ci_status",
    ):
        assert tool in registry


def test_get_pull_request_maps_dataclass_to_json(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    out = registry.dispatch("get_pull_request", {"id": "acme/web#42"})
    data = json.loads(out)
    assert data["state"] == "merged"
    assert data["labels"] == ["bug"]
    assert data["files"][0]["path"] == "a.py"
    assert data["reviews"][0]["author"] == "bob"
    assert data["updated_at"].startswith("2026-01-02")


def test_get_pull_request_diff_wraps_string(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    out = registry.dispatch("get_pull_request_diff", {"id": "acme/web#42"})
    data = json.loads(out)
    assert data["id"] == "acme/web#42"
    assert "diff for acme/web#42" in data["diff"]


def test_get_commit_maps_dataclass(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    out = registry.dispatch("get_commit", {"ref": "acme/web@deadbeef"})
    data = json.loads(out)
    assert data["sha"] == "deadbeef"
    assert data["files"][0]["path"] == "a.py"


def test_get_diff_requires_ref(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    out = registry.dispatch("get_diff", {})
    assert "ref is required" in json.loads(out)["error"]


def test_get_ci_status_reduction(tmp_path: Path) -> None:
    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_DetailProvider())
    out = registry.dispatch("get_ci_status", {"ref": "acme/web@deadbeef"})
    data = json.loads(out)
    assert data["overall"] == "success"
    assert data["runs"][0]["conclusion"] == "success"


def test_not_implemented_maps_to_soft_error(tmp_path: Path) -> None:
    class _BoomProvider(_DetailProvider):
        def get_pull_request(self, pr_id: str) -> PullRequestDetail:
            raise NotImplementedError

    registry = ToolRegistry()
    register_readonly_tools(registry, conn=_conn(tmp_path), provider=_BoomProvider())
    out = registry.dispatch("get_pull_request", {"id": "acme/web#42"})
    assert "does not support" in json.loads(out)["error"]
