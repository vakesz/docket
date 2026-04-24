from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.core.model import Item, ItemKind, ItemState

MakeItem = Callable[..., Item]


@pytest.fixture
def tmp_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Isolate XDG dirs under a temp root for the duration of a test.

    Also suppresses `load_project_env()` so the repo's own `.env` (which
    redirects XDG to `.docket-dev/`) doesn't clobber the monkeypatched
    paths when `resolve_paths()` fires — tests run from the repo root."""
    config = tmp_path / "config"
    state = tmp_path / "state"
    cache = tmp_path / "cache"
    for p in (config, state, cache):
        p.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.setenv("XDG_CACHE_HOME", str(cache))
    from docket.config import env as _env

    monkeypatch.setattr(_env, "_project_env_loaded", True)
    yield tmp_path


@pytest.fixture
def make_item() -> MakeItem:
    """Factory for building a default `Item` with a handful of sensible overrides.

    Replaces the `_mk_item` helper that was previously duplicated across
    integration tests. Default shape is a NEW STORY with stamped `updated_at`
    and empty `provider_key` (matches the field default)."""

    def _make(
        id: str = "S-1",
        *,
        title: str = "Login",
        kind: ItemKind = ItemKind.STORY,
        description_md: str = "Add login.",
        state: ItemState = ItemState.NEW,
        assignee: str | None = None,
        parent_id: str | None = None,
        provider_key: str = "",
        updated_at: datetime | None = None,
    ) -> Item:
        return Item(
            id=id,
            kind=kind,
            title=title,
            description_md=description_md,
            state=state,
            assignee=assignee,
            parent_id=parent_id,
            updated_at=updated_at or datetime.now(UTC),
            provider_key=provider_key,
        )

    return _make
