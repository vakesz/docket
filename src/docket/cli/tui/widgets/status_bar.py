"""Bottom-docked status bar for the main TUI.

Renders a single line with dot-separated segments: project · provider ·
scope · last sync · next sync · offline · N pending · cost · read-only.
Labels are intentionally plain English (no "streaming", no "READ-ONLY"
caps) so a new user can parse the bar without a glossary. The app wires
each segment by assigning to the reactive attributes on this widget.

The agent "thinking…" indicator deliberately lives inside `ChatPane`
only — duplicating it here pulls the eye away from the transcript where
the user is already looking.
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
    """Minute-precision countdown to a future timestamp.

    Sub-minute resolution is omitted intentionally: showing seconds causes the
    status bar to visually update on every repaint triggered by other reactive
    changes (thinking toggle, cost updates). Minute granularity is accurate
    enough and keeps the bar visually stable."""
    if target is None:
        return "—"
    now = datetime.now(UTC)
    t = target if target.tzinfo else target.replace(tzinfo=UTC)
    seconds = int((t - now).total_seconds())
    if seconds <= 0:
        return "now"
    if seconds < 60:
        return "< 1m"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


class StatusBar(Static):
    """One-line status bar docked at the bottom of the app."""

    COMPONENT_CLASSES: ClassVar[set[str]] = {
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
    project_name: reactive[str] = reactive("")
    last_sync: reactive[datetime | None] = reactive(None)
    next_sync_at: reactive[datetime | None] = reactive(None)
    active_view: reactive[str | None] = reactive(None)
    offline: reactive[bool] = reactive(False)
    pending_count: reactive[int] = reactive(0)
    cost_cents: reactive[int] = reactive(0)
    read_only: reactive[bool] = reactive(False)

    def render(self) -> Text:
        left = Text()

        def append_part(text: str, component: str | None = None) -> None:
            if left:
                left.append(" · ")
            # Component styles are only populated after the widget mounts
            # inside an App. Fall back to an unstyled segment in unit tests
            # where the bar is constructed standalone.
            style = None
            if component:
                try:
                    style = self.get_component_rich_style(component, partial=True)
                except KeyError:
                    style = None
            left.append(text, style=style)

        if self.project_name:
            append_part(self.project_name, "status-bar--accent")
        append_part(self.provider_name)
        append_part(self.scope_label)
        if self.active_view and self.active_view != self.scope_label:
            append_part(self.active_view)
        append_part(f"last sync {_format_relative(self.last_sync)}")
        if self.next_sync_at is not None:
            append_part(f"next sync in {_format_countdown(self.next_sync_at)}")
        if self.offline:
            append_part("offline", "status-bar--error")
        if self.pending_count > 0:
            noun = "proposal" if self.pending_count == 1 else "proposals"
            append_part(f"{self.pending_count} pending {noun}", "status-bar--accent")
        if self.cost_cents > 0:
            append_part(f"${self.cost_cents / 100:.2f}")
        if self.read_only:
            append_part("read-only", "status-bar--accent")

        right = Text(no_wrap=True)
        right.append("? help", style="dim")
        right.append("  ·  ", style="dim")
        right.append("^P commands", style="dim")

        # Pad between left and right so hints sit at the far right edge.
        width = self.size.width if self.size.width > 0 else 80
        # Subtract 2 for the padding: 0 1 means 1 char each side.
        available = width - 2
        gap = max(2, available - len(left.plain) - len(right.plain))
        out = left
        out.append(" " * gap)
        out.append_text(right)
        return out

    def on_mount(self) -> None:
        self.set_interval(60, self.refresh)

    def set_last_sync_now(self) -> None:
        self.last_sync = datetime.now(UTC)
