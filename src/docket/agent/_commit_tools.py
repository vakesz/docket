"""Commit and CI-status read tools. Private sub-module of `tool_defs`.

Provider-gated like `_pr_tools`: providers that don't expose commit/check
APIs simply don't register these tools, so the model never sees them in
the schema."""

from __future__ import annotations

from typing import Any

from docket.agent._helpers import arg_error, call_provider, required_str
from docket.agent.tools import ToolRegistry
from docket.providers.base import WorkItemProvider


def _commit_payload(detail: Any) -> dict[str, Any]:
    return {
        "sha": detail.sha,
        "url": detail.url,
        "author": detail.author,
        "author_email": detail.author_email,
        "committer": detail.committer,
        "committed_at": detail.committed_at.isoformat() if detail.committed_at else None,
        "message": detail.message,
        "parents": list(detail.parents),
        "additions": detail.additions,
        "deletions": detail.deletions,
        "files": [
            {
                "path": f.path,
                "status": f.status,
                "additions": f.additions,
                "deletions": f.deletions,
            }
            for f in detail.files
        ],
    }


def _ci_status_payload(status: Any) -> dict[str, Any]:
    return {
        "ref": status.ref,
        "overall": status.overall,
        "runs": [
            {
                "id": r.id,
                "name": r.name,
                "status": r.status,
                "conclusion": r.conclusion,
                "url": r.url,
                "head_sha": r.head_sha,
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "completed_at": r.completed_at.isoformat() if r.completed_at else None,
            }
            for r in status.runs
        ],
    }


def register_commit_tools(registry: ToolRegistry, *, provider: WorkItemProvider) -> None:
    get_commit_fn = getattr(provider, "get_commit", None)
    get_commit_diff_fn = getattr(provider, "get_commit_diff", None)
    get_ci = getattr(provider, "get_ci_status", None)

    if callable(get_commit_fn):

        def get_commit(args: dict[str, Any]) -> str:
            try:
                ref = required_str(args, "ref")
            except ValueError as e:
                return arg_error(str(e))
            return call_provider("commit fetch", lambda: get_commit_fn(ref), _commit_payload)

        registry.register(
            name="get_commit",
            description=(
                "Fetch commit metadata and touched-file summary. `ref` is "
                "`owner/name@sha` or a bare sha (resolved against the "
                "provider's default repo). Returns author, message, "
                "parents, additions/deletions totals, and a per-file "
                "status list — no patch text (see `get_diff`)."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Commit ref (`owner/name@sha` or bare sha).",
                    },
                },
                "required": ["ref"],
            },
            handler=get_commit,
        )

    if callable(get_commit_diff_fn):

        def get_diff(args: dict[str, Any]) -> str:
            try:
                ref = required_str(args, "ref")
            except ValueError as e:
                return arg_error(str(e))
            return call_provider(
                "commit diff fetch",
                lambda: get_commit_diff_fn(ref),
                lambda diff: {"ref": ref, "diff": diff},
            )

        registry.register(
            name="get_diff",
            description=(
                "Fetch the unified diff for a single commit. Truncated at "
                "a byte cap the same way `get_pull_request_diff` is. "
                "`ref` accepts `owner/name@sha` or a bare sha."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "Commit ref (`owner/name@sha` or bare sha).",
                    },
                },
                "required": ["ref"],
            },
            handler=get_diff,
        )

    if callable(get_ci):

        def get_ci_status(args: dict[str, Any]) -> str:
            try:
                ref = required_str(args, "ref")
            except ValueError as e:
                return arg_error(str(e))
            return call_provider("CI status fetch", lambda: get_ci(ref), _ci_status_payload)

        registry.register(
            name="get_ci_status",
            description=(
                "Fetch CI / check-run status for a PR id "
                "(`owner/name#NN`), commit (`owner/name@sha`), or branch "
                "(`owner/name@branch`). Returns an `overall` label "
                "(success / failure / pending / none) plus each run's "
                "status, conclusion, and URL. `none` means no CI is "
                "configured — different from `pending`."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "ref": {
                        "type": "string",
                        "description": "PR id, commit ref, or branch ref.",
                    },
                },
                "required": ["ref"],
            },
            handler=get_ci_status,
        )


__all__ = ["register_commit_tools"]
