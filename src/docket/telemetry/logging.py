"""Process-wide logging setup.

Textual takes over the terminal, so anything that prints to stdout/stderr during
a TUI session is invisible. A rotating file handler under `paths.log_dir` is
the only place the user can see tracebacks from worker threads (the chat turn,
the sync worker, etc.) — so we set it up once on startup and route the root
logger there.

Logs are emitted as one JSON object per line via `structlog`, with a small
canonical set of event keys (see `EVENT_KEYS` below). All log call sites in
docket SHOULD prefer `get_logger(__name__)` over plain `logging.getLogger`,
but stdlib loggers are still routed through the same handler so third-party
libraries are captured uniformly.

Call `init_logging(paths)` exactly once from `prepare()`. Re-invocations are
no-ops so tests and CLI commands can both go through the same code path."""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from typing import Any

import structlog

from docket.config.paths import Paths

#: Canonical event-key vocabulary. New keys are fine; reusing one of these
#: across modules keeps the JSON log queryable. Not enforced at runtime —
#: this is documentation for `structlog` call sites.
EVENT_KEYS: tuple[str, ...] = (
    "event",
    "project",
    "provider",
    "subagent",
    "conversation_id",
    "item_id",
    "tool_name",
    "tool_call_id",
    "latency_ms",
    "tokens_in",
    "tokens_out",
    "cost_cents",
    "outcome",  # ok | error | timeout | denied
    "error_type",
    "correlation_id",
)

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
    # Plain message format for the file: structlog renders the JSON payload
    # into `record.msg` already, so we just want the timestamp/level prefix
    # for any stdlib loggers that bypass structlog.
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _INITIALIZED = True


def get_logger(name: str | None = None, **initial_values: Any) -> structlog.stdlib.BoundLogger:
    """Return a bound structlog logger.

    Prefer this over `logging.getLogger` for any call site that emits
    structured event data. Initial bound values are convenience for adding
    `project=...`, `provider=...`, etc. once at the top of a module.
    """
    logger: structlog.stdlib.BoundLogger = structlog.get_logger(name)
    if initial_values:
        logger = logger.bind(**initial_values)
    return logger
