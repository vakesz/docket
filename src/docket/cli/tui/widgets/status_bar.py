"""Bottom-docked status bar for the main TUI.

Renders a single line with dot-separated segments: provider · scope ·
last-sync · offline · streaming · cost · read-only. Later milestones fill
in the pieces that are placeholders today (token/cost from the chat pane,
offline state from the sync service, read-only from the CLI flag), but
the widget is shaped so that wiring them is just `bar.set_*(value)` from
the app.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import ClassVar

from rich.text import Text
from textual.reactive import reactive
from textual.widgets import Static


def _format_relative(ts: datetime | None) -> str:
    if ts is None:
        return "never"
    now = datetime.now(UTC)
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=UTC)
    delta = now - ts
    seconds = int(delta.total_seconds())
    if seconds < 0:
        return "just now"
    if seconds < 60:
        return f"{seconds}s ago"
    if seconds < 3600:
        return f"{seconds // 60}m ago"
    if seconds < 86400:
        return f"{seconds // 3600}h ago"
    return f"{seconds // 86400}d ago"


def _format_countdown(target: datetime | None) -> str:
    """Round-up countdown to a future timestamp. Mirrors `_format_relative`
    style (`45s`, `3m`, `2h`) so the status bar reads the same whether a
    segment is looking backward or forward."""
    if target is None:
        return "—"
    now = datetime.now(UTC)
    t = target if target.tzinfo else target.replace(tzinfo=UTC)
    seconds = int((t - now).total_seconds())
    if seconds <= 0:
        return "now"
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


class StatusBar(Static):
    """One-line status bar docked at the bottom of the app."""

    COMPONENT_CLASSES: ClassVar[set[str]] = {
        "status-bar--warning",
        "status-bar--error",
        "status-bar--accent",
    }

    DEFAULT_CSS = """
    StatusBar {
        dock: bottom;
        height: 1;
        background: $panel;
        color: $text-muted;
        padding: 0 1;
    }
    StatusBar > .status-bar--warning {
        color: $text-warning;
        text-style: bold;
    }
    StatusBar > .status-bar--error {
        color: $text-error;
        text-style: bold;
    }
    StatusBar > .status-bar--accent {
        color: $text-accent;
        text-style: bold;
    }
    """

    provider_name: reactive[str] = reactive("—")
    scope_label: reactive[str] = reactive("—")
    last_sync: reactive[datetime | None] = reactive(None)
    next_sync_at: reactive[datetime | None] = reactive(None)
    active_view: reactive[str | None] = reactive(None)
    offline: reactive[bool] = reactive(False)
    streaming: reactive[bool] = reactive(False)
    cost_cents: reactive[int] = reactive(0)
    read_only: reactive[bool] = reactive(False)

    def render(self) -> Text:
        out = Text()

        def append_part(text: str, component: str | None = None) -> None:
            if out:
                out.append(" · ")
            style = self.get_component_rich_style(component, partial=True) if component else None
            out.append(text, style=style)

        append_part(self.provider_name)
        append_part(self.scope_label)
        if self.active_view and self.active_view != self.scope_label:
            append_part(self.active_view)
        append_part(f"synced {_format_relative(self.last_sync)}")
        if self.next_sync_at is not None:
            append_part(f"next {_format_countdown(self.next_sync_at)}")
        if self.offline:
            append_part("offline", "status-bar--error")
        if self.streaming:
            append_part("streaming", "status-bar--warning")
        if self.cost_cents > 0:
            append_part(f"${self.cost_cents / 100:.2f}")
        if self.read_only:
            append_part("READ-ONLY", "status-bar--accent")
        return out

    def set_last_sync_now(self) -> None:
        self.last_sync = datetime.now(UTC)
