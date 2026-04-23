"""Real GitHub Issues provider with pull-request discovery.

Talks to `api.github.com` over httpx. Auth rides on `gh auth token` — the
same short-lived session the user has for their local CLI — so we never
prompt for a PAT. Read paths are fully implemented; write paths cover
transition + patch_description + comment-as-attachment-fallback + create.

Mapping:
- Only GitHub Issues enter the work-item cache. Pull requests share the
  `/issues` REST surface, but they are discovered separately through
  `find_related_prs(...)` and do not become `Item`s.
- Issue `ItemKind` is guessed from labels (`bug` → BUG,
  `enhancement|feature` → STORY, else TASK).
- `updated_at` drives sync watermarks. `list_changes_since(wm, ...)` uses
  the REST `since=<iso>` query param.
- State mapping lives in `state_map.py` (shared with the stub).

Scope filters are partial — `assignee` maps to the GitHub `assignee` query
param; team/area/iteration don't apply and are ignored. Providers that
can't honor a filter return a superset, never a subset, so `list_changes_since`
may return extra rows that the storage layer filters again at write-time.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

import httpx

from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    PRMatch,
    ScopeFilters,
    TransitionIntent,
)
from docket.providers.base import ProviderUnreachableError
from docket.providers.github.auth import get_gh_token
from docket.providers.github.state_map import to_canonical, to_native

_DEFAULT_BASE_URL = "https://api.github.com"
_TIMEOUT = httpx.Timeout(20.0, connect=5.0)
_ACCEPT = "application/vnd.github+json"
_PER_PAGE = 100
_MAX_PAGES = 10


@dataclass
class GitHubProvider:
    """`WorkItemProvider` implementation for api.github.com.

    `default_repo` is the "owner/name" the wizard configures; single-repo
    mode is the common case and keeps the canonical id stable
    (`owner/name#number`). Multi-repo expansion is left to a follow-up."""

    default_repo: str
    display_name: str = "GitHub"
    base_url: str = _DEFAULT_BASE_URL
    _client: httpx.Client | None = None
    # Cached authenticated-user login, resolved lazily for `@me` filters.
    # Empty string is a negative cache — don't retry every sync.
    _me_login: str | None = None

    def __post_init__(self) -> None:
        if "/" not in self.default_repo:
            raise ValueError(f"default_repo must look like 'owner/name', got {self.default_repo!r}")

    # -- client plumbing ----------------------------------------------------

    def _client_or_make(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(
                base_url=self.base_url,
                headers=self._headers(),
                timeout=_TIMEOUT,
            )
        return self._client

    def _headers(self) -> dict[str, str]:
        token = get_gh_token()
        return {
            "Authorization": f"Bearer {token}",
            "Accept": _ACCEPT,
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        client = self._client_or_make()
        try:
            resp = client.get(path, params=params)
        except httpx.HTTPError as e:
            raise ProviderUnreachableError(f"GET {path} failed: {e}") from e
        if resp.status_code >= 400:
            raise ProviderUnreachableError(
                f"GET {path} returned {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        client = self._client_or_make()
        try:
            resp = client.post(path, json=body)
        except httpx.HTTPError as e:
            raise ProviderUnreachableError(f"POST {path} failed: {e}") from e
        if resp.status_code >= 400:
            raise ProviderUnreachableError(
                f"POST {path} returned {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    def _patch(self, path: str, body: dict[str, Any]) -> Any:
        client = self._client_or_make()
        try:
            resp = client.patch(path, json=body)
        except httpx.HTTPError as e:
            raise ProviderUnreachableError(f"PATCH {path} failed: {e}") from e
        if resp.status_code >= 400:
            raise ProviderUnreachableError(
                f"PATCH {path} returned {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()

    # -- reads --------------------------------------------------------------

    def health_check(self) -> None:
        self._get(f"/repos/{self.default_repo}")

    def current_user_identity(self) -> str | None:
        """Return the authenticated user's login for the `@me` visual filter."""
        return self._resolve_me_login()

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        # Initial sync (no watermark) sorts newest-first so page 1 is useful on
        # big repos; incremental sync walks forward from the watermark so asc
        # is needed for the watermark bump to be monotonic.
        direction = "asc" if watermark is not None else "desc"
        base_params: dict[str, str] = {
            "state": "all",
            "per_page": str(_PER_PAGE),
            "sort": "updated",
            "direction": direction,
        }
        if watermark is not None:
            base_params["since"] = watermark.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        # @me means "the authenticated user"; GitHub has no literal @me token,
        # so resolve to the login. If resolution fails, fall through with no
        # assignee filter rather than silently dropping every unassigned item.
        if filters.assignee == "@me":
            login = self._resolve_me_login()
            if login:
                base_params["assignee"] = login
        elif filters.assignee:
            base_params["assignee"] = filters.assignee

        out: list[Item] = []
        for page in range(1, _MAX_PAGES + 1):
            params = {**base_params, "page": str(page)}
            payload = self._get(f"/repos/{self.default_repo}/issues", params=params)
            if not isinstance(payload, list) or not payload:
                break
            out.extend(
                self._issue_to_item(entry)
                for entry in payload
                if isinstance(entry, dict) and not _is_pull_request_payload(entry)
            )
            if len(payload) < _PER_PAGE:
                break
        return out

    def _resolve_me_login(self) -> str | None:
        if self._me_login is not None:
            return self._me_login or None
        try:
            payload = self._get("/user")
        except ProviderUnreachableError:
            self._me_login = ""
            return None
        login = payload.get("login") if isinstance(payload, dict) else None
        self._me_login = str(login) if isinstance(login, str) and login else ""
        return self._me_login or None

    def get_item(self, id: str) -> Item:
        owner, repo, number = _parse_id(id)
        payload = self._get(f"/repos/{owner}/{repo}/issues/{number}")
        if not isinstance(payload, dict):
            raise KeyError(id)
        if _is_pull_request_payload(payload):
            raise KeyError(id)
        return self._issue_to_item(payload)

    def get_comments(self, id: str) -> list[Comment]:
        owner, repo, number = _parse_id(id)
        payload = self._get(f"/repos/{owner}/{repo}/issues/{number}/comments")
        if not isinstance(payload, list):
            return []
        out: list[Comment] = []
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            comment_id = str(entry.get("id", ""))
            author = (
                (entry.get("user") or {}).get("login", "")
                if isinstance(entry.get("user"), dict)
                else ""
            )
            body = entry.get("body") or ""
            created = _parse_iso(entry.get("created_at"))
            if not comment_id or created is None:
                continue
            out.append(
                Comment(
                    id=comment_id,
                    item_id=id,
                    author=str(author),
                    body_md=str(body),
                    created_at=created,
                )
            )
        return out

    def get_linked(self, id: str) -> list[Item]:
        # GitHub's REST doesn't expose first-class parent/child links;
        # real implementations typically parse "closes #N" from the body
        # or walk `tracked_issues` (GraphQL). Leaving empty matches the
        # stub contract.
        _ = id
        return []

    # -- writes -------------------------------------------------------------

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        owner, repo, number = _parse_id(id)
        native_state, native_reason = to_native(intent)
        body: dict[str, Any] = {"state": native_state}
        if native_reason:
            body["state_reason"] = native_reason
        payload = self._patch(f"/repos/{owner}/{repo}/issues/{number}", body)
        if not isinstance(payload, dict):
            raise ProviderUnreachableError(f"unexpected PATCH response for {id}")
        return self._issue_to_item(payload)

    def patch_description(self, id: str, new_md: str) -> Item:
        owner, repo, number = _parse_id(id)
        payload = self._patch(
            f"/repos/{owner}/{repo}/issues/{number}",
            {"body": new_md},
        )
        if not isinstance(payload, dict):
            raise ProviderUnreachableError(f"unexpected PATCH response for {id}")
        return self._issue_to_item(payload)

    def upload_attachment(self, id: str, filename: str, content: bytes, content_type: str) -> str:
        # GitHub REST has no attachment upload endpoint. The common workaround
        # is to post a comment whose body references an externally-hosted
        # asset. We raise — the mutation pipeline is expected to detect this
        # and route attachments elsewhere (or surface a useful error).
        _ = (id, filename, content, content_type)
        raise ProviderUnreachableError(
            "GitHub REST does not support direct attachment upload. "
            "Use a comment with an externally-hosted URL instead."
        )

    def add_comment(self, id: str, body_md: str) -> Comment:
        owner, repo, number = _parse_id(id)
        payload = self._post(
            f"/repos/{owner}/{repo}/issues/{number}/comments",
            {"body": body_md},
        )
        if not isinstance(payload, dict):
            raise ProviderUnreachableError(f"unexpected POST comments response for {id}")
        comment_id = str(payload.get("id", ""))
        author_obj = payload.get("user")
        author = (
            author_obj.get("login")
            if isinstance(author_obj, dict) and isinstance(author_obj.get("login"), str)
            else "unknown"
        )
        created = _parse_iso(payload.get("created_at"))
        if not comment_id or created is None:
            raise ProviderUnreachableError(f"comment payload missing id/created_at: {payload!r}")
        return Comment(
            id=comment_id,
            item_id=id,
            author=str(author),
            body_md=str(payload.get("body") or body_md),
            created_at=created,
        )

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        body: dict[str, Any] = {
            "title": fields.title,
            "body": fields.description_md or "",
        }
        if fields.assignee and fields.assignee != "@me":
            body["assignees"] = [fields.assignee]
        if fields.tags:
            body["labels"] = list(fields.tags)
        payload = self._post(f"/repos/{self.default_repo}/issues", body)
        if not isinstance(payload, dict):
            raise ProviderUnreachableError("unexpected POST /issues response")
        item = self._issue_to_item(payload)
        # Caller supplied the kind; preserve their intent even if label-guess disagrees.
        return Item(
            id=item.id,
            kind=kind,
            title=item.title,
            description_md=item.description_md,
            state=item.state,
            assignee=item.assignee,
            parent_id=item.parent_id,
            tags=list(item.tags),
            updated_at=item.updated_at,
            url=item.url,
            author=item.author,
            attachments=list(item.attachments),
            provider_raw=dict(item.provider_raw),
        )

    # -- PR discovery -------------------------------------------------------

    def find_related_prs(self, item_id: str, title_keywords: list[str]) -> list[PRMatch]:
        """Best-effort scan of recent PRs for ones that might close this item.

        Strategy, cheapest → most expensive:
        1. Pull the last ~100 PRs in this repo sorted by `updated` desc.
        2. A PR is a strong match if its title or body literally mentions the
           numeric part of `item_id` (`owner/name#NN` → `#NN`) or any of the
           keyword phrases. Weak match = keyword overlap alone.

        `confidence` is a rough soft-score the agent uses to decide whether
        to surface a link-back proposal; the UI ultimately decides. Errors
        (repo not found, rate limit) bubble up as `ProviderUnreachableError`
        — the agent tool catches and reports so discovery never takes down
        the chat turn."""
        _, _, number = _parse_id(item_id)
        params: dict[str, str] = {
            "state": "all",
            "per_page": "100",
            "sort": "updated",
            "direction": "desc",
        }
        payload = self._get(f"/repos/{self.default_repo}/pulls", params=params)
        if not isinstance(payload, list):
            return []
        kws = [kw.lower().strip() for kw in title_keywords if kw.strip()]
        id_token = f"#{number}"
        out: list[PRMatch] = []
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            title = str(entry.get("title") or "")
            body = str(entry.get("body") or "")
            haystack = f"{title}\n{body}".lower()
            strong = id_token in haystack
            hits = sum(1 for kw in kws if kw and kw in haystack)
            if not strong and hits == 0:
                continue
            confidence = 0.9 if strong else min(0.3 + 0.1 * hits, 0.8)
            head = entry.get("head") or {}
            branch = head.get("ref") if isinstance(head, dict) else ""
            state = str(entry.get("state") or "")
            if entry.get("merged_at"):
                state = "merged"
            user = entry.get("user") or {}
            author = user.get("login") if isinstance(user, dict) else ""
            out.append(
                PRMatch(
                    url=str(entry.get("html_url") or ""),
                    title=title,
                    branch=str(branch or ""),
                    state=state,
                    author=str(author or ""),
                    confidence=confidence,
                )
            )
        out.sort(key=lambda m: m.confidence, reverse=True)
        return out

    # -- mapping ------------------------------------------------------------

    def _issue_to_item(self, payload: dict[str, Any]) -> Item:
        number = payload.get("number")
        url = payload.get("html_url")
        repo_url = payload.get("repository_url", "")
        if isinstance(repo_url, str) and "/repos/" in repo_url:
            owner_name = repo_url.split("/repos/", 1)[1]
        else:
            owner_name = self.default_repo
        issue_id = f"{owner_name}#{number}"
        labels_raw = payload.get("labels") or []
        tags: list[str] = []
        for label in labels_raw:
            if isinstance(label, dict):
                name = label.get("name")
                if isinstance(name, str) and name:
                    tags.append(name)
            elif isinstance(label, str):
                tags.append(label)
        is_pr = _is_pull_request_payload(payload)
        kind = _guess_kind(tags, is_pr=is_pr)
        state = str(payload.get("state", ""))
        reason = payload.get("state_reason") or ""
        item_state: ItemState = to_canonical(state, str(reason))
        assignee_obj = payload.get("assignee")
        assignee = (
            assignee_obj.get("login")
            if isinstance(assignee_obj, dict) and isinstance(assignee_obj.get("login"), str)
            else None
        )
        user_obj = payload.get("user")
        author = (
            user_obj.get("login")
            if isinstance(user_obj, dict) and isinstance(user_obj.get("login"), str)
            else None
        )
        return Item(
            id=issue_id,
            kind=kind,
            title=str(payload.get("title", "")),
            description_md=str(payload.get("body") or ""),
            state=item_state,
            assignee=cast(str | None, assignee),
            parent_id=None,
            tags=tags,
            updated_at=_parse_iso(payload.get("updated_at")),
            url=str(url) if isinstance(url, str) else None,
            author=cast(str | None, author),
            provider_raw={
                "github_state": state,
                "github_state_reason": str(reason),
                "number": number,
                "is_pr": is_pr,
            },
        )


def _parse_id(id: str) -> tuple[str, str, str]:
    """Split an `owner/name#number` id into its parts. Raises ValueError on garbage."""
    if "#" not in id:
        raise ValueError(f"invalid GitHub item id {id!r} (missing '#')")
    repo_part, number = id.split("#", 1)
    if "/" not in repo_part:
        raise ValueError(f"invalid GitHub item id {id!r} (missing 'owner/name')")
    owner, name = repo_part.split("/", 1)
    return owner, name, number


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    # GitHub returns `2024-05-30T18:32:21Z` — Python's fromisoformat handles
    # that only after 3.11; we normalize the trailing Z defensively.
    text = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _is_pull_request_payload(payload: dict[str, Any]) -> bool:
    return "pull_request" in payload


def _guess_kind(tags: list[str], *, is_pr: bool) -> ItemKind:
    if is_pr:
        return ItemKind.TASK
    lowered = {t.lower() for t in tags}
    if "bug" in lowered:
        return ItemKind.BUG
    if {"enhancement", "feature", "story"} & lowered:
        return ItemKind.STORY
    if "epic" in lowered:
        return ItemKind.EPIC
    return ItemKind.TASK


__all__ = ["GitHubProvider"]
