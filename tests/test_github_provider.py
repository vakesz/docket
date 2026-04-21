"""Unit tests for the real GitHub provider.

Uses `httpx.MockTransport` so no network is touched — the provider is
injected with a prebuilt `httpx.Client` that routes every request through
a dispatcher function. We test the mapping layer (issue/pr → Item, kind
guessing, state mapping, id parsing) and the write-path URL shapes."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import httpx
import pytest

from docket.core.model import CreateFields, ItemKind, ItemState, ScopeFilters, TransitionIntent
from docket.providers.base import ProviderUnreachableError
from docket.providers.github.provider import GitHubProvider


def _issue_payload(
    *,
    number: int = 42,
    title: str = "Login crashes",
    state: str = "open",
    state_reason: str = "",
    body: str = "Steps...",
    labels: list[str] | None = None,
    assignee: str | None = None,
    is_pr: bool = False,
    updated_at: str = "2024-05-30T18:32:21Z",
    repo: str = "vakesz/docket",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "number": number,
        "title": title,
        "body": body,
        "state": state,
        "state_reason": state_reason,
        "labels": [{"name": n} for n in (labels or [])],
        "assignee": {"login": assignee} if assignee else None,
        "updated_at": updated_at,
        "html_url": f"https://github.com/{repo}/issues/{number}",
        "repository_url": f"https://api.github.com/repos/{repo}",
    }
    if is_pr:
        payload["pull_request"] = {"url": "..."}
    return payload


def _mk_provider(handler) -> GitHubProvider:
    """Build a GitHubProvider whose httpx.Client is wired to `handler`.

    `handler(request) -> httpx.Response` — the standard MockTransport shape."""
    transport = httpx.MockTransport(handler)
    client = httpx.Client(
        base_url="https://api.github.com",
        transport=transport,
        headers={"Authorization": "Bearer test", "Accept": "application/vnd.github+json"},
    )
    return GitHubProvider(default_repo="vakesz/docket", _client=client)


def test_default_repo_must_look_like_owner_name() -> None:
    with pytest.raises(ValueError, match="owner/name"):
        GitHubProvider(default_repo="bare")


def test_get_item_maps_fields_and_guesses_kind() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/vakesz/docket/issues/42"
        return httpx.Response(
            200,
            json=_issue_payload(labels=["bug"], assignee="alice"),
        )

    provider = _mk_provider(handler)
    item = provider.get_item("vakesz/docket#42")
    assert item.id == "vakesz/docket#42"
    assert item.kind is ItemKind.BUG
    assert item.state is ItemState.ACTIVE
    assert item.assignee == "alice"
    assert item.title == "Login crashes"
    assert item.tags == ["bug"]
    assert item.url == "https://github.com/vakesz/docket/issues/42"


def _static_handler(payload: dict[str, Any]):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return handler


def test_kind_guessing_prefers_bug_then_story_then_task() -> None:
    item = _mk_provider(_static_handler(_issue_payload(labels=["enhancement"]))).get_item(
        "vakesz/docket#1"
    )
    assert item.kind is ItemKind.STORY

    item = _mk_provider(_static_handler(_issue_payload(labels=[]))).get_item("vakesz/docket#1")
    assert item.kind is ItemKind.TASK


def test_pull_requests_map_to_task_regardless_of_labels() -> None:
    item = _mk_provider(
        _static_handler(_issue_payload(labels=["bug"], is_pr=True))
    ).get_item("vakesz/docket#1")
    assert item.kind is ItemKind.TASK


def test_closed_completed_maps_to_resolved() -> None:
    item = _mk_provider(
        _static_handler(_issue_payload(state="closed", state_reason="completed"))
    ).get_item("vakesz/docket#1")
    assert item.state is ItemState.RESOLVED


def test_closed_not_planned_maps_to_closed() -> None:
    item = _mk_provider(
        _static_handler(_issue_payload(state="closed", state_reason="not_planned"))
    ).get_item("vakesz/docket#1")
    assert item.state is ItemState.CLOSED


def test_list_changes_since_passes_iso_watermark() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["params"] = dict(request.url.params)
        captured["path"] = request.url.path
        return httpx.Response(200, json=[_issue_payload()])

    watermark = datetime(2024, 1, 1, 12, 30, 0, tzinfo=UTC)
    provider = _mk_provider(handler)
    items = list(provider.list_changes_since(watermark, ScopeFilters()))
    assert len(items) == 1
    assert captured["path"] == "/repos/vakesz/docket/issues"
    assert captured["params"]["since"] == "2024-01-01T12:30:00Z"
    assert captured["params"]["state"] == "all"


def test_transition_sends_native_state_and_reason() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PATCH":
            captured["method"] = request.method
            captured["path"] = request.url.path
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json=_issue_payload(state="closed", state_reason="completed"),
            )
        raise AssertionError(f"unexpected {request.method} {request.url}")

    provider = _mk_provider(handler)
    result = provider.transition("vakesz/docket#7", TransitionIntent.CLOSE_DONE)
    assert captured["path"] == "/repos/vakesz/docket/issues/7"
    assert captured["body"] == {"state": "closed", "state_reason": "completed"}
    assert result.state is ItemState.RESOLVED


def test_patch_description_sends_body_field() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json=_issue_payload(body="new desc"))

    provider = _mk_provider(handler)
    item = provider.patch_description("vakesz/docket#1", "new desc")
    assert captured["body"] == {"body": "new desc"}
    assert item.description_md == "new desc"


def test_create_item_posts_to_issues_endpoint() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["path"] = request.url.path
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            201,
            json=_issue_payload(number=99, title="new one", body="desc", labels=["bug"]),
        )

    provider = _mk_provider(handler)
    item = provider.create_item(
        ItemKind.STORY,
        CreateFields(title="new one", description_md="desc", tags=["bug"]),
    )
    assert captured["method"] == "POST"
    assert captured["path"] == "/repos/vakesz/docket/issues"
    assert captured["body"]["title"] == "new one"
    assert captured["body"]["labels"] == ["bug"]
    # Caller's kind wins over the label-guesser.
    assert item.kind is ItemKind.STORY


def test_upload_attachment_raises_with_guidance() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(204)

    provider = _mk_provider(handler)
    with pytest.raises(ProviderUnreachableError, match="attachment upload"):
        provider.upload_attachment("vakesz/docket#1", "f.txt", b"x", "text/plain")


def test_http_errors_surface_as_unreachable() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    provider = _mk_provider(handler)
    with pytest.raises(ProviderUnreachableError, match="500"):
        provider.get_item("vakesz/docket#1")


def test_bad_id_rejected_at_the_boundary() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    provider = _mk_provider(handler)
    with pytest.raises(ValueError, match="invalid GitHub item id"):
        provider.get_item("not-an-id")


def _pr_payload(
    *,
    number: int,
    title: str,
    body: str = "",
    state: str = "open",
    merged_at: str | None = None,
    branch: str = "feature/x",
    author: str = "alice",
    repo: str = "vakesz/docket",
) -> dict[str, Any]:
    return {
        "number": number,
        "title": title,
        "body": body,
        "state": state,
        "merged_at": merged_at,
        "head": {"ref": branch},
        "user": {"login": author},
        "html_url": f"https://github.com/{repo}/pull/{number}",
    }


def test_find_related_prs_strong_match_on_id_mention() -> None:
    """A PR whose body literally mentions `#<number>` gets high confidence —
    this is the clean `closes #42` / `fixes #42` case."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/repos/vakesz/docket/pulls"
        assert request.url.params.get("state") == "all"
        return httpx.Response(
            200,
            json=[
                _pr_payload(number=100, title="Unrelated refactor", body="tidy up"),
                _pr_payload(
                    number=101,
                    title="Fix login",
                    body="closes #42",
                    merged_at="2024-06-01T00:00:00Z",
                ),
            ],
        )

    provider = _mk_provider(handler)
    matches = provider.find_related_prs("vakesz/docket#42", ["login"])
    assert len(matches) == 1  # only PR 101 signals; PR 100 mentions neither
    top = matches[0]
    assert top.url.endswith("/pull/101")
    assert top.state == "merged"  # merged_at overrides "open" state
    assert top.confidence >= 0.8


def test_find_related_prs_keyword_only_match() -> None:
    """No id mention, but title keyword overlap — weaker confidence."""

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[_pr_payload(number=7, title="Tidy up the LOGIN flow", body="")],
        )

    provider = _mk_provider(handler)
    matches = provider.find_related_prs("vakesz/docket#42", ["login"])
    assert len(matches) == 1
    assert matches[0].confidence < 0.9  # weaker than a direct id mention


def test_find_related_prs_skips_when_no_signal() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[_pr_payload(number=1, title="Refactor parser", body="unrelated")],
        )

    provider = _mk_provider(handler)
    assert provider.find_related_prs("vakesz/docket#42", ["login"]) == []
