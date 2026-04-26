"""Round-trip tests against the in-memory keyring fixture."""

from __future__ import annotations

import pytest

from docket.config import secrets as secrets_mod


def test_get_returns_none_when_unset() -> None:
    assert secrets_mod.get_llm_api_key() is None


def test_set_then_get_round_trips() -> None:
    hint = secrets_mod.set_llm_api_key("sk-" + "x" * 40)
    assert hint.configured is True
    assert hint.length == 43
    assert secrets_mod.get_llm_api_key() == "sk-" + "x" * 40


def test_set_strips_surrounding_whitespace() -> None:
    secrets_mod.set_llm_api_key("  sk-trim-me  ")
    assert secrets_mod.get_llm_api_key() == "sk-trim-me"


def test_set_rejects_empty_or_whitespace() -> None:
    with pytest.raises(ValueError):
        secrets_mod.set_llm_api_key("")
    with pytest.raises(ValueError):
        secrets_mod.set_llm_api_key("   \n  ")


def test_clear_removes_value() -> None:
    secrets_mod.set_llm_api_key("a" * 20)
    secrets_mod.clear_llm_api_key()
    assert secrets_mod.get_llm_api_key() is None


def test_clear_is_idempotent_when_unset() -> None:
    secrets_mod.clear_llm_api_key()
    secrets_mod.clear_llm_api_key()  # second call must not raise


def test_keyring_available_with_in_memory_backend() -> None:
    ok, err = secrets_mod.keyring_available()
    assert ok is True
    assert err is None
