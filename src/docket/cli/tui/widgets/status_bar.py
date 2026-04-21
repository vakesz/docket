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


class StatusBar(Static):
    """One-line status bar docked at the bottom of the app."""

    DEFAULT_CSS = """
    StatusBar {
        dock: bottom;
        height: 1;
        background: $panel;
        color: $text-muted;
        padding: 0 1;
    }
    """

    provider_name: reactive[str] = reactive("—")
    scope_label: reactive[str] = reactive("—")
    last_sync: reactive[datetime | None] = reactive(None)
    offline: reactive[bool] = reactive(False)
    streaming: reactive[bool] = reactive(False)
    cost_cents: reactive[int] = reactive(0)
    read_only: reactive[bool] = reactive(False)

    def render(self) -> str:
        parts: list[str] = []
        parts.append(f"provider: {self.provider_name}")
        parts.append(f"scope: {self.scope_label}")
        parts.append(f"sync: {_format_relative(self.last_sync)}")
        if self.offline:
            parts.append("[b red]offline[/]")
        if self.streaming:
            parts.append("[b yellow]streaming[/]")
        if self.cost_cents > 0:
            parts.append(f"cost: ${self.cost_cents / 100:.2f}")
        if self.read_only:
            parts.append("[b magenta]READ-ONLY[/]")
        return " · ".join(parts)

    def set_last_sync_now(self) -> None:
        self.last_sync = datetime.now(UTC)
