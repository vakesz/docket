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

Telemetry is enabled by default and logs at DEBUG so handoffs to the small
group of operators reviewing the JSON log have as much context as possible.
When `config.telemetry.enabled` is `False`, the file handler is removed and
the root logger is silenced.

Call `init_logging(paths, enabled=...)` from `prepare()`. The function may be
called more than once (for example, with a bootstrap default before
`config.toml` is loaded and again with the resolved telemetry settings); each
call replaces the previous handler so the latest configuration wins."""

from __future__ import annotations

import contextlib
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

#: Sentinel attribute we put on handlers we own, so re-init can clean up only
#: docket's own handler without touching anything pytest/uvicorn/etc. attached.
_DOCKET_HANDLER_ATTR = "_docket_telemetry_handler"

#: Effective level used when telemetry is disabled — silences everything,
#: including `CRITICAL`, without removing the call sites.
_DISABLED_LEVEL = logging.CRITICAL + 10


def init_logging(
    paths: Paths,
    *,
    enabled: bool = True,
    level: int | None = None,
) -> None:
    """Configure the root logger and structlog for docket.

    `enabled` mirrors `config.telemetry.enabled`. When `True` (the default),
    the level defaults to `DEBUG` so the on-disk JSON log captures everything
    — this is intentional: the log is rotated (1 MB x 3) and shared with a
    handful of operators, and verbose context beats missing context. When
    `False`, all docket-owned handlers are removed and the root logger is
    silenced.

    `level` overrides the default level when telemetry is enabled.
    """
    root = logging.getLogger()
    # Drop any handler we previously attached so re-init is clean. Leave
    # foreign handlers (pytest's caplog, uvicorn, etc.) alone.
    for existing in list(root.handlers):
        if getattr(existing, _DOCKET_HANDLER_ATTR, False):
            root.removeHandler(existing)
            with contextlib.suppress(Exception):
                existing.close()

    if not enabled:
        root.setLevel(_DISABLED_LEVEL)
        # Keep structlog wired up but filtered out, so call sites that bound
        # values at import time don't blow up — they just no-op. structlog
        # only accepts standard logging levels for its filtering wrapper, so
        # use CRITICAL here; the stdlib root level (above CRITICAL) is what
        # actually silences output.
        structlog.configure(
            processors=[structlog.processors.JSONRenderer()],
            wrapper_class=structlog.make_filtering_bound_logger(logging.CRITICAL),
            logger_factory=structlog.stdlib.LoggerFactory(),
            cache_logger_on_first_use=False,
        )
        return

    effective_level = level if level is not None else logging.DEBUG
    paths.log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        paths.log_dir / "docket.log",
        maxBytes=1_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    setattr(handler, _DOCKET_HANDLER_ATTR, True)
    handler.setLevel(effective_level)
    # Plain message format for the file: structlog renders the JSON payload
    # into `record.msg` already, so we just want the timestamp/level prefix
    # for any stdlib loggers that bypass structlog.
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-5s %(name)s: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root.setLevel(effective_level)
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
        wrapper_class=structlog.make_filtering_bound_logger(effective_level),
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=False,
    )


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
