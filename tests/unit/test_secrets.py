"""Pure tests for `docket.config.secrets.make_hint`. No keyring touched."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from docket.config.secrets import make_hint


def test_make_hint_empty_returns_unconfigured() -> None:
    hint = make_hint("")
    assert hint.configured is False
    assert hint.length == 0
    assert hint.prefix == ""
    assert hint.suffix == ""
    assert hint.updated_at is None


def test_make_hint_whitespace_treated_as_empty() -> None:
    hint = make_hint("   \n\t  ")
    assert hint.configured is False
    assert hint.length == 0


def test_make_hint_short_value_omits_preview_but_reports_length() -> None:
    # 8 chars — below the 16-char preview floor. Length is still revealed so
    # the UI can show 'configured (8 chars)'; prefix/suffix stay empty.
    hint = make_hint("abcd1234")
    assert hint.configured is True
    assert hint.length == 8
    assert hint.prefix == ""
    assert hint.suffix == ""


def test_make_hint_full_value_reveals_first_and_last_four() -> None:
    key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"  # 39 chars
    hint = make_hint(key)
    assert hint.configured is True
    assert hint.length == 39
    assert hint.prefix == "sk-a"
    assert hint.suffix == "6789"


def test_make_hint_strips_surrounding_whitespace_before_measuring() -> None:
    raw = "  " + "x" * 30 + "  "
    hint = make_hint(raw)
    assert hint.length == 30
    assert hint.prefix == "xxxx"
    assert hint.suffix == "xxxx"


def test_make_hint_updated_at_is_recent_utc() -> None:
    before = datetime.now(UTC)
    hint = make_hint("a" * 20)
    after = datetime.now(UTC)
    assert hint.updated_at is not None
    assert before - timedelta(seconds=1) <= hint.updated_at <= after + timedelta(seconds=1)
