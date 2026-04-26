from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from pathlib import Path

import keyring
import pytest
from keyring.backend import KeyringBackend

from docket.core.model import Item, ItemKind, ItemState

MakeItem = Callable[..., Item]


class _InMemoryKeyring(KeyringBackend):
    """Keyring backend used across the suite so tests don't touch the host
    keychain. Stored values are scoped per-test by the autouse fixture below."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self._store.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self._store[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        if (service, username) not in self._store:
            from keyring.errors import PasswordDeleteError

            raise PasswordDeleteError("not found")
        del self._store[(service, username)]


@pytest.fixture(autouse=True)
def _in_memory_keyring(monkeypatch: pytest.MonkeyPatch) -> Iterator[_InMemoryKeyring]:
    """Install a fresh in-memory keyring backend for every test.

    Without this, any code path that calls `keyring.set_password(...)` would
    write to the developer's real macOS Keychain / Linux Secret Service —
    cross-test contamination plus a pile of stale entries on the host."""
    backend = _InMemoryKeyring()
    monkeypatch.setattr(keyring, "set_keyring", lambda kr: None)
    monkeypatch.setattr(keyring, "get_keyring", lambda: backend)
    monkeypatch.setattr(keyring, "get_password", backend.get_password)
    monkeypatch.setattr(keyring, "set_password", backend.set_password)
    monkeypatch.setattr(keyring, "delete_password", backend.delete_password)
    yield backend


@pytest.fixture
def tmp_xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Isolate XDG dirs under a temp root for the duration of a test."""
    config = tmp_path / "config"
    state = tmp_path / "state"
    cache = tmp_path / "cache"
    for p in (config, state, cache):
        p.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))
    monkeypatch.setenv("XDG_STATE_HOME", str(state))
    monkeypatch.setenv("XDG_CACHE_HOME", str(cache))
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
