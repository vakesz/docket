"""Cover the status-bar label vocabulary.

The bar is the TUI's primary at-a-glance readout, so its labels need to
read as plain English even to a new user. The tests lock in the specific
strings ("last sync", "next sync in", "thinking…", "N pending proposal(s)",
"read-only") so a well-meaning cleanup doesn't accidentally reintroduce
internal jargon like "READ-ONLY" or "streaming"."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from docket.cli.tui.widgets.status_bar import StatusBar


def _rendered(bar: StatusBar) -> str:
    return str(bar.render())


def test_default_bar_uses_plain_labels() -> None:
    bar = StatusBar()
    bar.provider_name = "Contoso DevOps"
    bar.scope_label = "my-team"
    bar.active_view = "my-team"
    text = _rendered(bar)
    assert "last sync never" in text
    assert "streaming" not in text
    assert "READ-ONLY" not in text


def test_sync_segments_include_human_labels() -> None:
    bar = StatusBar()
    bar.last_sync = datetime.now(UTC) - timedelta(minutes=3)
    bar.next_sync_at = datetime.now(UTC) + timedelta(minutes=5)
    text = _rendered(bar)
    assert "last sync" in text
    assert "next sync in" in text


def test_thinking_flag_renders_friendly_word() -> None:
    bar = StatusBar()
    bar.thinking = True
    text = _rendered(bar)
    assert "thinking" in text
    assert "streaming" not in text


def test_pending_count_segment_pluralizes() -> None:
    bar = StatusBar()
    bar.pending_count = 1
    assert "1 pending proposal" in _rendered(bar)
    assert "1 pending proposals" not in _rendered(bar)

    bar.pending_count = 3
    assert "3 pending proposals" in _rendered(bar)


def test_zero_pending_count_hides_segment() -> None:
    bar = StatusBar()
    bar.pending_count = 0
    assert "pending" not in _rendered(bar)


def test_read_only_segment_is_lowercase() -> None:
    bar = StatusBar()
    bar.read_only = True
    text = _rendered(bar)
    assert "read-only" in text
    assert "READ-ONLY" not in text
