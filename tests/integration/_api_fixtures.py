"""Shared builders for the `test_api_*` suites.

The monolith `test_api.py` used to carry one env + client fixture that every
test in the file referenced. When we split the file by domain (auth / items
/ mutations / conversation), each split wanted the same wiring — but other
integration tests already define their own `env` / `client` fixtures with
different shapes, so promoting fixtures to a conftest.py would shadow them.

This module exports the raw builder instead. Each split file declares its
own tiny `env` / `client` fixture that calls `build_api_env()` — one line
per file, no fixture-name collision with the rest of `tests/integration/`."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from docket.api import create_app
from docket.api.runtime import RuntimeState
from docket.config import Config, ProviderEntry
from docket.config.models import SavedView
from docket.core.services.proposal_store import ProposalStore
from docket.storage import init_db
from docket.storage.repos import item_repo
from tests.conftest import MakeItem
from tests.fakes.provider import FakeProvider

TOKEN = "test-bearer-token-abcdef"
AUTH_HEADERS = {"Authorization": f"Bearer {TOKEN}"}


class MeProvider(FakeProvider):
    """FakeProvider with a stable current-user id so active-view filtering
    by `@me` resolves to an actual string. The original fake returns None,
    which collapses the `@me` branch in the view filter."""

    def current_user_identity(self) -> str | None:
        return "fake-user"


@dataclass
class ApiEnv:
    """Bundle of wired test state — a SQLite cache, a fake provider already
    seeded with one item, a proposal store, a pre-built Config + RuntimeState
    pair, and the seed item. Tests pull whatever they need out of this."""

    conn: Any
    provider: MeProvider
    proposals: ProposalStore
    item: Any
    config: Config
    runtime: RuntimeState


def build_api_env(tmp_path: Path, make_item: MakeItem) -> ApiEnv:
    """Wire one SQLite + provider + runtime triple seeded with a single story.

    Mirrors the original `env` fixture from the monolithic test_api.py — the
    split-out files each wrap this in their own pytest fixture so teardown
    (conn.close()) happens at the right scope."""
    conn = init_db(tmp_path / "docket.db")
    item = make_item(provider_key="main")
    item_repo.upsert_item(conn, item)
    provider = MeProvider(items=[item])
    proposals = ProposalStore()
    config = Config(
        providers={
            "main": ProviderEntry(
                type="github_stub",
                display_name="Stub",
                config={},
                views={"default": SavedView(), "mine": SavedView(assignees=["@me"])},
                active_view="default",
            )
        },
        active_provider="main",
    )
    runtime = RuntimeState(
        config=config,
        providers={"main": provider},
        provider_key="main",
    )
    return ApiEnv(
        conn=conn,
        provider=provider,
        proposals=proposals,
        item=item,
        config=config,
        runtime=runtime,
    )


def build_client(env: ApiEnv, **overrides: Any) -> TestClient:
    """Build a TestClient against the shared env. `overrides` are forwarded to
    `create_app` so individual tests can swap in, e.g., an `llm=` fake."""
    app = create_app(
        conn=env.conn,
        provider=env.provider,
        bearer_token=TOKEN,
        proposals=env.proposals,
        runtime=env.runtime,
        config=env.config,
        **overrides,
    )
    return TestClient(app)


def parse_sse(lines: Any) -> list[dict[str, str]]:
    """Parse sse-starlette output into a list of `{event, data}` dicts.

    Accepts either bytes or str lines (httpx `iter_lines()` yields str).
    Drops comment/keepalive lines and coalesces multi-line `data:` fields
    by concatenation, matching the SSE spec."""
    events: list[dict[str, str]] = []
    current: dict[str, str] = {}
    for raw in lines:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        if text == "":
            if current:
                events.append(current)
                current = {}
            continue
        if text.startswith(":"):  # keepalive / comment
            continue
        if ":" not in text:
            continue
        field, _, value = text.partition(":")
        value = value.lstrip()
        if field == "event":
            current["event"] = value
        elif field == "data":
            current["data"] = current.get("data", "") + value
    if current:
        events.append(current)
    return events


__all__ = [
    "AUTH_HEADERS",
    "TOKEN",
    "ApiEnv",
    "MeProvider",
    "build_api_env",
    "build_client",
    "parse_sse",
]
