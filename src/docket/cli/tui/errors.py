"""Plain-language error formatting for TUI toasts.

Exceptions bubble up from every layer — network sockets, HTTP clients,
the filesystem, pydantic validators. Raw `str(exc)` lands the model's
traceback slang in the user's face ("HTTPSConnectionPool(...)", "[Errno
-2] Name or service not known"). `humanize` reads the exception and
returns a short "what happened / what to do next" sentence instead.

Call sites pass the user-visible *action* (e.g. `"Sync"`, `"Apply"`) so
the rendered message reads like a complete thought and the caller can
append a retry hint pointing at the relevant keybinding.
"""

from __future__ import annotations

import re

# Technical words that signal a connectivity problem when they appear in
# the exception class name or message. Order matters: the first match wins.
_NETWORK_SIGNS: tuple[str, ...] = (
    "ConnectionError",
    "ConnectTimeout",
    "ReadTimeout",
    "WriteTimeout",
    "SSLError",
    "gaierror",
    "NameResolutionError",
    "TimeoutError",
)

_AUTH_SIGNS: tuple[str, ...] = (
    "PermissionError",
    "AuthenticationError",
    "Unauthorized",
)

_STATUS_RE = re.compile(r"\b(\d{3})\b")


def humanize(exc: BaseException, *, action: str = "Action") -> str:
    """Return a 1-sentence plain-language summary of `exc` for a toast.

    `action` is the user-facing verb describing what failed — "Sync",
    "Apply", "Save settings". It's capitalized in the caller's voice,
    so we don't re-case it here.
    """
    exc_name = type(exc).__name__
    message = str(exc).strip() or exc_name

    status = _http_status(message)
    if status == 401 or status == 403:
        return f"{action} was refused — check your credentials in config.toml."
    if status == 404:
        return f"{action} failed — the item or endpoint is gone on the server."
    if status == 429:
        return f"{action} was rate-limited. Wait a moment, then retry."
    if status is not None and status >= 500:
        return f"{action} failed because the provider had a server error ({status})."

    if _matches(exc_name, _AUTH_SIGNS) or _matches(message, _AUTH_SIGNS):
        return f"{action} was refused — check your credentials in config.toml."

    if _matches(exc_name, _NETWORK_SIGNS) or _matches(message, _NETWORK_SIGNS):
        return f"{action} couldn't reach the server — check your network connection."

    # Fallback: keep it short but don't pretend we know what happened.
    return f"{action} didn't complete — {_trim(message)}."


def retry_hint(key: str, label: str) -> str:
    """Format a one-click-retry hint, e.g. `"Press r to retry sync."`."""
    return f"Press {key} to retry {label}."


def _matches(text: str, needles: tuple[str, ...]) -> bool:
    lowered = text.lower()
    return any(needle.lower() in lowered for needle in needles)


def _http_status(message: str) -> int | None:
    match = _STATUS_RE.search(message)
    if match is None:
        return None
    code = int(match.group(1))
    return code if 400 <= code < 600 else None


def _trim(message: str, *, limit: int = 140) -> str:
    cleaned = message.replace("\n", " ").strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


__all__ = ["humanize", "retry_hint"]
