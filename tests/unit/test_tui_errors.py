"""Lock in the plain-language error helper.

These tests pin the friendly sentences so a well-meaning refactor can't
regress the wording. The goal is: a user reading one of these toasts
knows *what* went wrong and *what to do next*, without learning what a
`gaierror` is."""

from __future__ import annotations

import socket

from docket.cli.tui.errors import humanize, retry_hint


def test_network_error_points_at_connection() -> None:
    exc = ConnectionError("Connection refused")
    msg = humanize(exc, action="Sync")
    assert msg.startswith("Sync couldn't reach the server")
    assert "network" in msg


def test_dns_failure_is_also_network() -> None:
    exc = socket.gaierror(-2, "Name or service not known")
    msg = humanize(exc, action="Sync")
    assert "couldn't reach" in msg


def test_401_and_403_mention_credentials() -> None:
    for status in (401, 403):
        exc = RuntimeError(f"HTTP {status} Unauthorized")
        msg = humanize(exc, action="Sync")
        assert "credentials" in msg


def test_404_says_gone_on_server() -> None:
    exc = RuntimeError("HTTP 404 not found: https://example/items/S-42")
    assert "gone on the server" in humanize(exc, action="Open")


def test_429_suggests_wait() -> None:
    exc = RuntimeError("HTTP 429 Too Many Requests")
    assert "rate-limited" in humanize(exc, action="Sync")


def test_5xx_names_the_status() -> None:
    exc = RuntimeError("HTTP 503 Service Unavailable")
    msg = humanize(exc, action="Sync")
    assert "server error" in msg
    assert "503" in msg


def test_unknown_error_keeps_short_detail_not_class_name() -> None:
    exc = ValueError("no cached item with id=S-7")
    msg = humanize(exc, action="Apply")
    assert msg.startswith("Apply didn't complete")
    assert "no cached item with id=S-7" in msg
    assert "ValueError" not in msg


def test_unknown_error_trims_long_traceback_text() -> None:
    long = "x" * 500
    msg = humanize(RuntimeError(long), action="Apply")
    assert "…" in msg
    assert len(msg) < 300


def test_retry_hint_formats() -> None:
    assert retry_hint("r", "sync") == "Press r to retry sync."
