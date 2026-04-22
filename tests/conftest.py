from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest


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
