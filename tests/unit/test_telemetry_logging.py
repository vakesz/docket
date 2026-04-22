"""Cover the telemetry init contract:

- enabled (default) -> DEBUG-level rotating file handler under `paths.log_dir`
- disabled -> docket-owned handler removed, root silenced above CRITICAL
- re-init replaces only the docket handler, leaves foreign handlers alone
- level override is honored
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pytest

from docket.config.paths import Paths
from docket.telemetry.logging import _DOCKET_HANDLER_ATTR, init_logging


@pytest.fixture
def paths(tmp_path: Path) -> Paths:
    p = Paths(
        config_dir=tmp_path / "config",
        state_dir=tmp_path / "state",
        cache_dir=tmp_path / "cache",
    )
    p.ensure()
    return p


@pytest.fixture(autouse=True)
def reset_root_handlers() -> Iterator[None]:
    """Strip docket-owned handlers before & after each test so state from one
    case doesn't leak into the next. Foreign handlers (pytest's caplog) stay."""
    root = logging.getLogger()
    saved_level = root.level
    saved = [h for h in root.handlers if not getattr(h, _DOCKET_HANDLER_ATTR, False)]
    for h in list(root.handlers):
        if getattr(h, _DOCKET_HANDLER_ATTR, False):
            root.removeHandler(h)
    yield
    for h in list(root.handlers):
        if getattr(h, _DOCKET_HANDLER_ATTR, False):
            root.removeHandler(h)
    for h in saved:
        if h not in root.handlers:
            root.addHandler(h)
    root.setLevel(saved_level)


def _docket_handlers() -> list[logging.Handler]:
    return [h for h in logging.getLogger().handlers if getattr(h, _DOCKET_HANDLER_ATTR, False)]


def test_enabled_default_is_debug(paths: Paths) -> None:
    init_logging(paths)
    handlers = _docket_handlers()
    assert len(handlers) == 1
    handler = handlers[0]
    assert isinstance(handler, RotatingFileHandler)
    assert handler.level == logging.DEBUG
    assert logging.getLogger().level == logging.DEBUG
    assert paths.log_dir.exists()


def test_disabled_removes_handler_and_silences_root(paths: Paths) -> None:
    init_logging(paths)
    assert _docket_handlers(), "precondition: handler attached when enabled"

    init_logging(paths, enabled=False)
    assert _docket_handlers() == []
    # CRITICAL+10: anything ever logged is filtered out
    assert logging.getLogger().level > logging.CRITICAL


def test_reinit_replaces_only_docket_handler(paths: Paths) -> None:
    foreign = logging.NullHandler()
    logging.getLogger().addHandler(foreign)
    try:
        init_logging(paths)
        init_logging(paths)  # re-init
        docket = _docket_handlers()
        assert len(docket) == 1, "old docket handler should be replaced, not stacked"
        assert foreign in logging.getLogger().handlers, "foreign handler must survive"
    finally:
        logging.getLogger().removeHandler(foreign)


def test_explicit_level_override(paths: Paths) -> None:
    init_logging(paths, level=logging.WARNING)
    handlers = _docket_handlers()
    assert handlers and handlers[0].level == logging.WARNING
    assert logging.getLogger().level == logging.WARNING


def test_disabled_then_reenabled_restores_handler(paths: Paths) -> None:
    init_logging(paths, enabled=False)
    assert _docket_handlers() == []

    init_logging(paths, enabled=True, level=logging.INFO)
    handlers = _docket_handlers()
    assert len(handlers) == 1
    assert handlers[0].level == logging.INFO
