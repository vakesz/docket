"""Single source of truth for secret-grade values (currently the LLM API key).

Storage backend is the OS keyring (macOS Keychain / Windows Credential Manager
/ freedesktop Secret Service). No env-var fallback, no plaintext file — the
trade-off is documented in CLAUDE.md and surfaced via `keyring_available()`
so callers can produce a clean error rather than silently failing.

Only this module imports `keyring`; the import-boundary test enforces it.

Public API:
- `get_llm_api_key()`           — read the current key, or `None`.
- `set_llm_api_key(value)`      — store the key, return the matching `KeyHint`.
- `clear_llm_api_key()`         — remove the key from the keyring.
- `make_hint(value)`            — build a `KeyHint` for a given key string (pure).
- `keyring_available()`         — probe the backend; returns `(ok, error)`.
"""

from __future__ import annotations

import contextlib
from datetime import UTC, datetime

import keyring
from keyring.errors import KeyringError, NoKeyringError, PasswordDeleteError

from docket.config.models import KeyHintConfig

SERVICE = "docket"
ACCOUNT_LLM_KEY = "azure_openai_api_key"

# Below this length we don't render `prefix`/`suffix` previews — too few chars
# means showing 4-and-4 leaks most of the key. Real Azure OpenAI keys are 84
# chars, so this only kicks in for malformed input the user typed by mistake.
_HINT_MIN_LENGTH = 16
_HINT_EDGE = 4


def keyring_available() -> tuple[bool, str | None]:
    """Probe the keyring backend without writing anything.

    Returns `(True, None)` if a real keyring is reachable, otherwise
    `(False, <human message>)` so callers can surface the diagnostic.

    `keyring.get_keyring()` is cheap and never raises; the actual failure
    mode is a `NoKeyringError` on first read/write. We do a get-only probe
    here because writing a sentinel value would pollute the user's keychain
    on the off chance the backend works."""
    try:
        backend = keyring.get_keyring()
    except Exception as exc:  # pragma: no cover — defensive
        return False, f"keyring backend init failed: {exc}"
    name = backend.__class__.__name__
    if name in {"fail.Keyring", "Keyring"} and "fail" in name.lower():
        return False, "no system keyring detected"
    try:
        # Touch the backend with a known-empty account so we surface
        # NoKeyringError early instead of waiting for the first real call.
        keyring.get_password(SERVICE, "__probe__")
    except NoKeyringError as exc:
        return False, str(exc) or "no system keyring detected"
    except KeyringError as exc:
        return False, str(exc)
    return True, None


def get_llm_api_key() -> str | None:
    """Read the Azure OpenAI API key from the OS keyring.

    Returns `None` if no key is stored or if the keyring backend is
    unavailable — callers must check `keyring_available()` separately if
    they need to distinguish "no key" from "no keyring"."""
    try:
        value = keyring.get_password(SERVICE, ACCOUNT_LLM_KEY)
    except KeyringError:
        return None
    if value is None or value == "":
        return None
    return value


def set_llm_api_key(value: str) -> KeyHintConfig:
    """Store the key and return the matching `KeyHintConfig`.

    Empty / whitespace-only input is rejected — use `clear_llm_api_key()`
    when removing. Raises `KeyringError` if the backend rejects the write
    (e.g. locked keychain on macOS); callers convert that to the user-facing
    error."""
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("api key must be non-empty; use clear_llm_api_key() to remove")
    keyring.set_password(SERVICE, ACCOUNT_LLM_KEY, cleaned)
    return make_hint(cleaned)


def clear_llm_api_key() -> None:
    """Remove the key from the OS keyring. No-op if it isn't set."""
    # Already-gone is the idempotency contract callers expect.
    with contextlib.suppress(PasswordDeleteError):
        keyring.delete_password(SERVICE, ACCOUNT_LLM_KEY)


def make_hint(value: str) -> KeyHintConfig:
    """Pure helper: build a non-secret hint for a key string.

    Returns `configured=False` for empty input. For values shorter than
    `_HINT_MIN_LENGTH`, omits the prefix/suffix preview to avoid leaking
    most of the key; the length is still reported so the UI can show
    'Key configured (12 chars)'."""
    cleaned = value.strip()
    if not cleaned:
        return KeyHintConfig()
    length = len(cleaned)
    if length < _HINT_MIN_LENGTH:
        prefix = ""
        suffix = ""
    else:
        prefix = cleaned[:_HINT_EDGE]
        suffix = cleaned[-_HINT_EDGE:]
    return KeyHintConfig(
        configured=True,
        prefix=prefix,
        suffix=suffix,
        length=length,
        updated_at=datetime.now(UTC),
    )


__all__ = [
    "ACCOUNT_LLM_KEY",
    "SERVICE",
    "clear_llm_api_key",
    "get_llm_api_key",
    "keyring_available",
    "make_hint",
    "set_llm_api_key",
]
