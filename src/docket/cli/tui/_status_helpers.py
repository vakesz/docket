"""Helpers for updating the StatusBar when it may not yet be mounted.

The bar is composed at app startup, but worker threads and pre-mount
setters can touch it before that. `query_one(StatusBar)` raises
`NoMatches` until composition finishes, so every field-set has been
wrapped in `with contextlib.suppress(Exception):`. This helper keeps
the suppression in one place and lets call sites read as one line.

Use `update_status_bar` for simple field assignments. Read-modify-write
(e.g. `cost_cents += delta`) and method calls (`set_last_sync_now()`)
still need the explicit suppress because they hold a bar reference."""

from __future__ import annotations

import contextlib
from typing import Any

from textual.app import App

from docket.cli.tui.widgets.status_bar import StatusBar


def update_status_bar(app: App[Any], **fields: Any) -> None:
    """Atomically push field updates to StatusBar; no-op if not mounted yet."""
    with contextlib.suppress(Exception):
        bar = app.query_one(StatusBar)
        for name, value in fields.items():
            setattr(bar, name, value)


__all__ = ["update_status_bar"]
