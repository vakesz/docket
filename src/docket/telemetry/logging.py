"""Process-wide logging setup.

Textual takes over the terminal, so anything that prints to stdout/stderr during
a TUI session is invisible. A rotating file handler under `paths.log_dir` is
the only place the user can see tracebacks from worker threads (the chat turn,
the sync worker, etc.) — so we set it up once on startup and route the root
logger there.

Call `init_logging(paths)` exactly once from `prepare()`. Re-invocations are
no-ops so tests and CLI commands can both go through the same code path."""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler

from docket.config.paths import Paths

_INITIALIZED = False


def init_logging(paths: Paths, *, level: int = logging.INFO) -> None:
    global _INITIALIZED
    if _INITIALIZED:
        return
    paths.log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        paths.log_dir / "docket.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)
    _INITIALIZED = True
