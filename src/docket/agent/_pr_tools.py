"""PR discovery and detail tools. Private sub-module of `tool_defs`.

All tools are provider-gated: registered only when the provider exposes the
backing method. This keeps the schema list honest for providers that don't
speak git (e.g. `github_stub`) so the model never hallucinates PR queries."""

from __future__ import annotations

import json
from typing import Any

from docket.agent._helpers import (
    arg_error,
    provider_error,
    provider_unsupported,
    required_str,
    str_list,
)
from docket.agent.tools import ToolRegistry
from docket.providers.base import WorkItemProvider


def _pull_request_payload(detail: Any) -> dict[str, Any]:
    return {
        "id": detail.id,
        "url": detail.url,
        "title": detail.title,
        "number": detail.number,
        "state": detail.state,
        "author": detail.author,
        "body_md": detail.body_md,
        "head_ref": detail.head_ref,
        "base_ref": detail.base_ref,
        "head_sha": detail.head_sha,
        "draft": detail.draft,
        "merged": detail.merged,
        "mergeable": detail.mergeable,
        "labels": list(detail.labels),
        "requested_reviewers": list(detail.requested_reviewers),
        "additions": detail.additions,
        "deletions": detail.deletions,
        "changed_files": detail.changed_files,
        "files": [
            {
                "path": f.path,
                "status": f.status,
                "additions": f.additions,
                "deletions": f.deletions,
            }
            for f in detail.files
        ],
        "reviews": [
            {
                "author": r.author,
                "state": r.state,
                "body_md": r.body_md,
                "submitted_at": r.submitted_at.isoformat() if r.submitted_at else None,
            }
            for r in detail.reviews
        ],
        "comments_count": detail.comments_count,
        "review_comments_count": detail.review_comments_count,
        "updated_at": detail.updated_at.isoformat() if detail.updated_at else None,
    }


def register_pr_tools(registry: ToolRegistry, *, provider: WorkItemProvider) -> None:
    find_prs = getattr(provider, "find_related_prs", None)
    get_pr = getattr(provider, "get_pull_request", None)
    get_pr_diff = getattr(provider, "get_pull_request_diff", None)

    if callable(find_prs):

        def find_related_prs(args: dict[str, Any]) -> str:
            try:
                id_ = required_str(args, "id")
                kws = str_list(args, "title_keywords")
            except ValueError as e:
                return arg_error(str(e))
            try:
                matches = find_prs(id_, kws)
            except NotImplementedError:
                return provider_unsupported("PR discovery")
            except Exception as e:
                return provider_error(e)
            return json.dumps(
                [
                    {
                        "url": m.url,
                        "title": m.title,
                        "branch": m.branch,
                        "state": m.state,
                        "author": m.author,
                        "confidence": round(m.confidence, 2),
                    }
                    for m in matches
                ]
            )

        registry.register(
            name="find_related_prs",
            description=(
                "Find pull requests that might be related to this work item. "
                "Scans recent PRs for mentions of the id or the supplied title keywords. "
                "Returns best-effort matches with a confidence score; nothing is linked until the user confirms."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Work item id."},
                    "title_keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Short phrases from the item's title that likely appear in a related PR.",
                        "default": [],
                    },
                },
                "required": ["id"],
            },
            handler=find_related_prs,
        )

    if callable(get_pr):

        def get_pull_request(args: dict[str, Any]) -> str:
            try:
                pr_id = required_str(args, "id")
            except ValueError as e:
                return arg_error(str(e))
            try:
                detail = get_pr(pr_id)
            except NotImplementedError:
                return provider_unsupported("PR detail fetch")
            except Exception as e:
                return provider_error(e)
            return json.dumps(_pull_request_payload(detail))

        registry.register(
            name="get_pull_request",
            description=(
                "Fetch full detail for a pull request by id (same "
                "`owner/name#NN` shape as work item ids). Returns title, "
                "state, labels, author, body_md, head/base refs, "
                "additions/deletions totals, a list of touched files "
                "(first pages), and any submitted reviews. Call "
                "`get_pull_request_diff` separately for the actual patch — "
                "diffs are large and not bundled in this response."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Pull request id in `owner/name#NN` form.",
                    },
                },
                "required": ["id"],
            },
            handler=get_pull_request,
        )

    if callable(get_pr_diff):

        def get_pull_request_diff(args: dict[str, Any]) -> str:
            try:
                pr_id = required_str(args, "id")
            except ValueError as e:
                return arg_error(str(e))
            try:
                diff = get_pr_diff(pr_id)
            except NotImplementedError:
                return provider_unsupported("PR diff fetch")
            except Exception as e:
                return provider_error(e)
            return json.dumps({"id": pr_id, "diff": diff})

        registry.register(
            name="get_pull_request_diff",
            description=(
                "Fetch the unified diff for a pull request. Output is "
                "truncated at a byte cap (the provider appends a "
                "`diff truncated` marker) so a single huge PR can't blow "
                "the context window. Use this *after* `get_pull_request` "
                "to reason about what actually changed."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Pull request id in `owner/name#NN` form.",
                    },
                },
                "required": ["id"],
            },
            handler=get_pull_request_diff,
        )


__all__ = ["register_pr_tools"]
