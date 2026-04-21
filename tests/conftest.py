from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


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
